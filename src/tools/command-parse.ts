// Static analysis of a bash command line — enough to decide whether a command
// can be auto-approved against an allowlist, and no more.
//
// The point of this module is the negative result. A permission model that
// allowlists by string prefix is trivially defeated:
//
//   git status; rm -rf ~
//   $(echo rm) -rf /
//   echo cm0gLXJmIC8= | base64 -d | sh
//
// So before any rule is consulted, the command is split into the segments the
// shell would actually run, and anything whose effect cannot be determined by
// reading the text — command substitution, variable expansion, redirection to
// a real path, here-docs, subshells — is recorded in `opaque`. A command with
// a non-empty `opaque` list is never auto-approved, whatever the rules say.
//
// This is deliberately not a bash parser. It over-approximates: constructs it
// does not understand are reported as opaque rather than skipped, so the
// failure mode is an unnecessary approval prompt, never a silent bypass.

/** One command the shell would execute, after splitting on `;`, `&&`, `|`, … */
export interface CommandSegment {
  /** The binary as written. `git`, `./build.sh`, `/usr/bin/env` — not
   *  normalised, because a rule for `git` must not match `./git`. */
  bin: string;
  args: string[];
  /** The segment's source text, for display in the approval prompt. */
  raw: string;
}

export interface ParsedCommand {
  segments: CommandSegment[];
  /** Human-readable descriptions of constructs that defeat static analysis.
   *  Non-empty means "never auto-approve". */
  opaque: string[];
}

/** Operators that end one command and begin another. */
const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n']);

interface Word {
  value: string;
  /** Set when the whole word came out of single quotes, where `$` is inert. */
  literal: boolean;
}

type Token = { kind: 'word'; word: Word } | { kind: 'op'; value: string };

/**
 * Splits a command line into the segments bash would run, recording every
 * construct that makes the outcome unknowable from the text alone.
 */
export function parseCommand(command: string): ParsedCommand {
  const opaque: string[] = [];
  const tokens = tokenize(command, opaque);
  const segments = groupIntoSegments(tokens, opaque);
  return { segments, opaque: dedupe(opaque) };
}

function tokenize(src: string, opaque: string[]): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let bufStarted = false;
  let literal = true;

  const flush = (): void => {
    if (!bufStarted) return;
    tokens.push({ kind: 'word', word: { value: buf, literal } });
    buf = '';
    bufStarted = false;
    literal = true;
  };
  const push = (text: string): void => {
    buf += text;
    bufStarted = true;
  };
  const op = (value: string): void => {
    flush();
    tokens.push({ kind: 'op', value });
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;

    if (c === '\\') {
      // A backslash-newline is a line continuation and disappears entirely.
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < src.length) {
        push(src[i + 1] as string);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        opaque.push('unterminated single quote');
        push(src.slice(i + 1));
        break;
      }
      push(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    if (c === '"') {
      const consumed = readDoubleQuoted(src, i, opaque);
      push(consumed.text);
      literal = literal && consumed.literal;
      i = consumed.next;
      continue;
    }

    if (c === '`') {
      opaque.push('backtick command substitution');
      const end = src.indexOf('`', i + 1);
      i = end === -1 ? src.length : end + 1;
      literal = false;
      push('');
      continue;
    }

    if (c === '$') {
      const consumed = readDollar(src, i, opaque);
      literal = false;
      push('');
      i = consumed;
      continue;
    }

    if (c === '<' || c === '>') {
      // A bare run of digits immediately before a redirection is an fd number
      // (`2>&1`), not a word of its own.
      let fd = '';
      if (bufStarted && /^\d+$/.test(buf)) {
        fd = buf;
        buf = '';
        bufStarted = false;
      }
      flush();
      i = readRedirection(src, i, fd, opaque);
      continue;
    }

    if (c === '(' || c === ')') {
      opaque.push('subshell grouping');
      flush();
      i += 1;
      continue;
    }

    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      const two = src.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === ';;' || two === '|&') {
        op(two === ';;' ? ';' : two);
        i += 2;
        continue;
      }
      op(c);
      i += 1;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i += 1;
      continue;
    }

    push(c);
    i += 1;
  }

  flush();
  return tokens;
}

/** Consumes a double-quoted run, flagging the expansions that live inside it. */
function readDoubleQuoted(
  src: string,
  start: number,
  opaque: string[],
): { text: string; next: number; literal: boolean } {
  let out = '';
  let literal = true;
  let i = start + 1;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\\' && i + 1 < src.length) {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') return { text: out, next: i + 1, literal };
    if (c === '`') {
      opaque.push('backtick command substitution');
      literal = false;
      const end = src.indexOf('`', i + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '$') {
      literal = false;
      i = readDollar(src, i, opaque);
      continue;
    }
    out += c;
    i += 1;
  }
  opaque.push('unterminated double quote');
  return { text: out, next: i, literal };
}

/** Consumes a `$…` expansion and records what kind it was. */
function readDollar(src: string, start: number, opaque: string[]): number {
  const next = src[start + 1];

  if (next === '(') {
    // `$((…))` is arithmetic, `$(…)` is a command. Both are opaque, but the
    // labels matter in the prompt the user sees.
    const arithmetic = src[start + 2] === '(';
    opaque.push(arithmetic ? 'arithmetic expansion' : 'command substitution');
    return skipBalanced(src, start + 1, '(', ')');
  }

  if (next === '{') {
    opaque.push('variable expansion');
    return skipBalanced(src, start + 1, '{', '}');
  }

  if (next !== undefined && /[A-Za-z_?$!#*@0-9-]/.test(next)) {
    opaque.push('variable expansion');
    let i = start + 1;
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i] as string)) i += 1;
    // Single-character specials ($?, $$, $1) consume exactly one character.
    return i === start + 1 ? start + 2 : i;
  }

  // A lone `$` before whitespace is a literal dollar sign.
  return start + 1;
}

/**
 * Consumes a redirection and its target. `>/dev/null` and fd duplication
 * (`2>&1`) are benign and dropped; everything else writes or reads somewhere
 * a rule cannot see, so it is opaque.
 */
function readRedirection(src: string, start: number, fd: string, opaque: string[]): number {
  let i = start;
  let op = '';
  while (i < src.length && (src[i] === '<' || src[i] === '>' || src[i] === '&' || src[i] === '|')) {
    op += src[i];
    i += 1;
  }

  if (op.startsWith('<<')) {
    opaque.push(op.startsWith('<<<') ? 'here-string' : 'here-document');
    return src.length;
  }

  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i += 1;

  let target = '';
  while (i < src.length && !/[\s;&|<>()]/.test(src[i] as string)) {
    target += src[i];
    i += 1;
  }

  if (op.endsWith('&') && /^\d+$|^-$/.test(target)) return i;
  if (target === '/dev/null') return i;

  const label = op.startsWith('<') ? 'input redirection' : 'output redirection';
  opaque.push(target ? `${label} to ${target}` : label);
  return i;
}

function skipBalanced(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

function groupIntoSegments(tokens: Token[], opaque: string[]): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current: Word[] = [];

  const commit = (): void => {
    if (current.length === 0) return;
    const words = stripEnvAssignments(current, opaque);
    if (words.length > 0) {
      const first = words[0] as Word;
      segments.push({
        bin: first.value,
        args: words.slice(1).map((w) => w.value),
        raw: words.map((w) => w.value).join(' '),
      });
    }
    current = [];
  };

  for (const token of tokens) {
    if (token.kind === 'op' && SEPARATORS.has(token.value)) {
      commit();
      continue;
    }
    // Words that came out of an expansion are pushed as empty placeholders;
    // they carry no name to match a rule against.
    if (token.kind === 'word' && token.word.value !== '') current.push(token.word);
  }
  commit();
  return segments;
}

/**
 * Drops leading `VAR=value` assignments so `FOO=1 npm test` is judged as
 * `npm test`. An assignment whose value came from an expansion has already
 * been marked opaque by the tokenizer.
 */
function stripEnvAssignments(words: Word[], opaque: string[]): Word[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test((words[i] as Word).value)) i += 1;
  if (i > 0 && i === words.length) {
    // Assignments with no command after them set shell state for later
    // segments, which a per-segment rule check cannot account for.
    opaque.push('bare environment assignment');
  }
  return words.slice(i);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
