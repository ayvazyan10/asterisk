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
// reading the text — command substitution, unsafe expansion, redirection to
// a real path, here-docs, subshells — is recorded in `opaque`. Relaxed policy
// can resolve output redirections against its sandbox's writable paths.
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
  /** Literal output redirection targets, also recorded in `opaque`. */
  outputs?: string[];
  /** Receives the previous segment's output through a pipe. */
  piped?: boolean;
}

export interface ParsedCommand {
  segments: CommandSegment[];
  /** Human-readable descriptions of constructs that defeat static analysis.
   *  Output redirections can be resolved by sandbox-aware policy. */
  opaque: string[];
}

/** Operators that end one command and begin another. */
const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n']);

interface Word {
  value: string;
  /** No expansion contributed to this word. */
  literal: boolean;
  unquotedVariable: boolean;
}

type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; value: string }
  | { kind: 'output'; target: string };

const SIMPLE_VARIABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/;

/**
 * Splits a command line into the segments bash would run, recording every
 * construct that makes the outcome unknowable from the text alone.
 */
export function parseCommand(command: string): ParsedCommand {
  const opaque: string[] = [];
  const tokens = tokenize(command, opaque);
  const segments = groupIntoSegments(tokens, opaque);
  // A quoted "$X" is judged harmless because its value comes from outside the
  // command. When the command itself sets X (`export X=-rf; rm "$X" ~`,
  // `for X in -rf; do …`), the value is chosen by the command after all.
  if (
    /\$\{?[A-Za-z_]/.test(command) &&
    segments.some(
      (segment) =>
        VARIABLE_SETTERS.has(segment.bin) ||
        (segment.bin === 'printf' && segment.args.some((arg) => /^-[^-]*v/.test(arg))),
    )
  ) {
    opaque.push('a variable set and expanded in the same command');
  }
  return { segments, opaque: dedupe(opaque) };
}

const VARIABLE_SETTERS = new Set([
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'read',
  'mapfile',
  'readarray',
  'for',
  'select',
  'getopts',
  'let',
]);

function tokenize(src: string, opaque: string[]): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let bufStarted = false;
  let literal = true;
  let unquotedVariable = false;
  let expansionPrefix: string | null = null;

  const flush = (): void => {
    if (!bufStarted) return;
    tokens.push({ kind: 'word', word: { value: buf, literal, unquotedVariable } });
    buf = '';
    bufStarted = false;
    literal = true;
    unquotedVariable = false;
    expansionPrefix = null;
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
      if (!consumed.literal) expansionPrefix ??= buf + consumed.prefix;
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
      const simple = src.slice(i).match(SIMPLE_VARIABLE)?.[0];
      if (simple) {
        expansionPrefix ??= buf;
        push(simple);
        literal = false;
        unquotedVariable = true;
        i += simple.length;
        continue;
      }
      const consumed = readDollar(src, i, opaque);
      literal = false;
      push('');
      i = consumed;
      continue;
    }

    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      if (src[i + 1] === '(') {
        opaque.push('process substitution');
        i = skipBalanced(src, i + 1, '(', ')');
        continue;
      }
      // A bare run of digits immediately before a redirection is an fd number
      // (`2>&1`), not a word of its own.
      let fd = '';
      if (bufStarted && /^\d+$/.test(buf)) {
        fd = buf;
        buf = '';
        bufStarted = false;
      }
      flush();
      i = readRedirection(src, i, fd, opaque, tokens);
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

    // Expansion can create extra arguments or filenames that are options.
    // Quotes and backslashes have already been consumed above, so only bare
    // expansion characters reach here. A literal prefix prevents a filename
    // from becoming a flag; --include=*.ts remains that option's value too.
    if (c === '{' || c === '*' || c === '?' || c === '[') {
      expansionPrefix ??= buf;
      if (!expansionPrefix || (expansionPrefix.startsWith('-') && !expansionPrefix.includes('='))) {
        opaque.push(c === '{' ? 'brace expansion' : 'pathname expansion');
      }
      literal = false;
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
): { text: string; next: number; literal: boolean; prefix: string } {
  let out = '';
  let literal = true;
  let prefix: string | null = null;
  let i = start + 1;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\\' && i + 1 < src.length) {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '"') return { text: out, next: i + 1, literal, prefix: prefix ?? out };
    if (c === '`') {
      opaque.push('backtick command substitution');
      prefix ??= out;
      literal = false;
      const end = src.indexOf('`', i + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '$') {
      prefix ??= out;
      literal = false;
      const simple = src.slice(i).match(SIMPLE_VARIABLE)?.[0];
      if (simple) {
        out += simple;
        i += simple.length;
        continue;
      }
      i = readDollar(src, i, opaque);
      continue;
    }
    out += c;
    i += 1;
  }
  opaque.push('unterminated double quote');
  return { text: out, next: i, literal, prefix: prefix ?? out };
}

/** Consumes a `$…` expansion and records what kind it was. */
function readDollar(src: string, start: number, opaque: string[]): number {
  const next = src[start + 1];

  if (next === "'" || next === '"') {
    // `$'…'` is ANSI-C quoting and `$"…"` is locale translation. Both decode
    // escapes this tokenizer does not implement, so `$'-\x65xec'` reads here as
    // the literal text `-\x65xec` while bash runs `-exec` — a forbidden
    // argument delivered past a pattern that only ever sees the undecoded
    // spelling. Reimplementing bash's escape table would be writing a second
    // bash; the module's standing answer to "this cannot be resolved by
    // reading it" is to call the construct opaque, and that is what these get.
    // Inside a double-quoted run bash treats `$'` as two literal characters,
    // so flagging it there over-approximates: an extra prompt, never a bypass.
    opaque.push(next === "'" ? 'ANSI-C quoted string' : 'locale-translated string');
    return skipQuoted(src, start + 1, next);
  }

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
function readRedirection(
  src: string,
  start: number,
  fd: string,
  opaque: string[],
  tokens: Token[],
): number {
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

  const targetStart = i;
  while (i < src.length && !/[\s;&|<>()]/.test(src[i] as string)) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') i = skipQuoted(src, i, c);
    else if (c === '\\') i += 2;
    else if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      const open = src[i + 1] as string;
      i = skipBalanced(src, i + 1, open, open === '(' ? ')' : '}');
    } else i += 1;
  }
  const target = src.slice(targetStart, i);

  if (op.endsWith('&') && /^\d+$|^-$/.test(target)) return i;
  const words = tokenize(target, opaque);
  const word = words.length === 1 && words[0]?.kind === 'word' ? words[0].word : null;
  if (!word?.literal) opaque.push('expansion in a redirection target');
  if (word?.literal && word.value === '/dev/null') return i;

  const label = op.startsWith('<') ? 'input redirection' : 'output redirection';
  const path = word?.value ?? target;
  opaque.push(path ? `${label} to ${path}` : label);
  if (label === 'output redirection' && word?.literal) {
    tokens.push({ kind: 'output', target: path });
  }
  return i;
}

/**
 * Consumes a quoted run from its opening quote, honouring backslash escapes.
 * An unterminated run swallows the rest of the input, which is what bash would
 * do with the next line too.
 */
function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return src.length;
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
  let outputs: string[] = [];
  let piped = false;

  const commit = (separator?: string): void => {
    const words = stripEnvAssignments(current, opaque);
    if (words.length === 0 && outputs.length > 0) {
      opaque.push('a redirection without a command');
    }
    if (words.length > 0) {
      const first = words[0] as Word;
      if (!first.literal) {
        opaque.push('expansion in the command name');
      }
      if (
        words.slice(1).some((word) => word.unquotedVariable) &&
        first.value !== 'echo' &&
        first.value !== 'printf'
      ) {
        opaque.push('variable expansion');
      }
      segments.push({
        bin: first.value,
        args: words.slice(1).map((w) => w.value),
        raw: words.map((w) => w.value).join(' '),
        ...(outputs.length > 0 ? { outputs } : {}),
        ...(piped ? { piped: true } : {}),
      });
    }
    current = [];
    outputs = [];
    piped = separator === '|' || separator === '|&';
  };

  for (const token of tokens) {
    if (token.kind === 'op' && SEPARATORS.has(token.value)) {
      commit(token.value);
      continue;
    }
    // Words that came out of an expansion are pushed as empty placeholders;
    // they carry no name to match a rule against.
    if (token.kind === 'word' && token.word.value !== '') current.push(token.word);
    if (token.kind === 'output') outputs.push(token.target);
  }
  commit();
  return segments;
}

/**
 * Strips leading `VAR=value` assignments so the segment reads as the command
 * it runs — `DISPLAY=:10.0 npm test` is shown as `npm test`. Names that change
 * program lookup, inject code or configure Git remain opaque, as do values
 * containing command substitution, even when quoted literally.
 */
function stripEnvAssignments(words: Word[], opaque: string[]): Word[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test((words[i] as Word).value)) {
    const assignment = (words[i] as Word).value;
    const name = assignment.slice(0, assignment.indexOf('='));
    if (
      /^(?:LD_|DYLD_|GIT_)/.test(name) ||
      /^(?:PATH|BASH_ENV|ENV|IFS|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|NODE_PATH|PAGER|MANPAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE|BROWSER|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/.test(
        name,
      ) ||
      /\$\(|`/.test(assignment)
    ) {
      opaque.push('environment assignment');
    }
    if ((words[i] as Word).unquotedVariable) opaque.push('variable expansion');
    i += 1;
  }
  if (i === 0) return words;
  // Assignments with no command after them additionally set shell state for
  // later segments, which a per-segment rule check cannot account for.
  if (i === words.length) opaque.push('bare environment assignment');
  return words.slice(i);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
