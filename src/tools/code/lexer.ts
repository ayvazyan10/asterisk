// Tokeniser for the RunCode mini-language — a deliberate subset of JavaScript.
//
// Hand-written rather than delegated to a real JS parser, and that is the whole
// security argument. `node:vm` is not a boundary: give a context one host
// callable and `fn.constructor('return process')()` hands the script the host
// realm's `process`, which on this Node carries `env` (every secret in the
// environment) and `getBuiltinModule('node:fs').writeFileSync` (every write the
// write-policy and the bubblewrap sandbox exist to bound). Measured, not
// assumed — see the module header of interpreter.ts.
//
// So the language cannot contain the constructs an escape needs. Refusing them
// at the syntax layer is a shorter and more auditable list than letting a
// general parser accept `new`, `class`, getters, `require` and `import()` and
// then trying to reject each one at evaluation time.

export type TokenKind = 'num' | 'str' | 'tmpl' | 'name' | 'punct' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text for punctuation and identifiers; cooked text for strings. */
  value: string;
  /** Parsed value, `num` only. */
  num: number;
  /** `tmpl` only: this chunk opens the literal. */
  head: boolean;
  /** `tmpl` only: this chunk closes the literal. */
  tail: boolean;
  /** A line break sits between this token and the previous one.
   *
   *  Semicolons are optional, so the parser needs one restricted production to
   *  keep `const a = 1` followed by `(b)` on the next line from parsing as a
   *  call of `1`. `.` is deliberately not restricted, so a multi-line
   *  `arr\n  .filter(…)` chain still works. */
  nlBefore: boolean;
  line: number;
  col: number;
}

export class CodeSyntaxError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(message: string, line: number, col: number) {
    super(message);
    this.name = 'CodeSyntaxError';
    this.line = line;
    this.col = col;
  }
}

/** Longest-first, so `===` never lexes as `==` followed by `=`. */
const PUNCT: readonly string[] = [
  '===',
  '!==',
  '...',
  '**',
  '=>',
  '??',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '?.',
  '<',
  '>',
  '=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '?',
  ':',
  ';',
  ',',
  '.',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
  $: '$',
};

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** Mutable cursor, kept in one object so the chunk readers can advance it. */
interface Cursor {
  src: string;
  i: number;
  line: number;
  col: number;
}

function at(c: Cursor, offset = 0): string {
  return c.src[c.i + offset] ?? '';
}

function advance(c: Cursor, n = 1): void {
  for (let k = 0; k < n; k += 1) {
    if (c.src[c.i] === '\n') {
      c.line += 1;
      c.col = 1;
    } else {
      c.col += 1;
    }
    c.i += 1;
  }
}

function token(kind: TokenKind, value: string, line: number, col: number): Token {
  return { kind, value, num: 0, head: false, tail: false, nlBefore: false, line, col };
}

/** Reads a `\`-escape, cursor sitting on the backslash. */
function readEscape(c: Cursor): string {
  advance(c); // the backslash
  const e = at(c);
  if (e === '') throw new CodeSyntaxError('unterminated escape sequence', c.line, c.col);

  if (e === 'u') {
    advance(c);
    if (at(c) === '{') {
      advance(c);
      let hex = '';
      while (at(c) !== '}' && at(c) !== '') {
        hex += at(c);
        advance(c);
      }
      if (at(c) !== '}') throw new CodeSyntaxError('unterminated \\u{…} escape', c.line, c.col);
      advance(c);
      const code = Number.parseInt(hex, 16);
      if (Number.isNaN(code)) throw new CodeSyntaxError('bad \\u{…} escape', c.line, c.col);
      return String.fromCodePoint(code);
    }
    const hex = c.src.slice(c.i, c.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new CodeSyntaxError('bad \\uXXXX escape', c.line, c.col);
    }
    advance(c, 4);
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  if (e === 'x') {
    advance(c);
    const hex = c.src.slice(c.i, c.i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      throw new CodeSyntaxError('bad \\xNN escape', c.line, c.col);
    }
    advance(c, 2);
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  advance(c);
  // A line continuation produces nothing; an unknown escape is the character
  // itself, which is what JavaScript does.
  if (e === '\n') return '';
  return SIMPLE_ESCAPES[e] ?? e;
}

function readString(c: Cursor, quote: string): Token {
  const line = c.line;
  const col = c.col;
  advance(c); // opening quote
  let out = '';
  for (;;) {
    const ch = at(c);
    if (ch === '') throw new CodeSyntaxError('unterminated string literal', line, col);
    if (ch === '\n') throw new CodeSyntaxError('unterminated string literal', line, col);
    if (ch === quote) {
      advance(c);
      return token('str', out, line, col);
    }
    if (ch === '\\') {
      out += readEscape(c);
      continue;
    }
    out += ch;
    advance(c);
  }
}

/**
 * Reads one literal chunk of a template, starting after a backtick or `}`.
 * Stops at the closing backtick (`tail`) or at a `${` (an expression follows).
 */
function readTemplateChunk(c: Cursor, head: boolean): Token {
  const line = c.line;
  const col = c.col;
  let out = '';
  for (;;) {
    const ch = at(c);
    if (ch === '') throw new CodeSyntaxError('unterminated template literal', line, col);
    if (ch === '`') {
      advance(c);
      const t = token('tmpl', out, line, col);
      t.head = head;
      t.tail = true;
      return t;
    }
    if (ch === '$' && at(c, 1) === '{') {
      advance(c, 2);
      const t = token('tmpl', out, line, col);
      t.head = head;
      t.tail = false;
      return t;
    }
    if (ch === '\\') {
      out += readEscape(c);
      continue;
    }
    out += ch;
    advance(c);
  }
}

function readNumber(c: Cursor): Token {
  const line = c.line;
  const col = c.col;
  const start = c.i;

  if (at(c) === '0' && (at(c, 1) === 'x' || at(c, 1) === 'X')) {
    advance(c, 2);
    while (/[0-9a-fA-F_]/.test(at(c))) advance(c);
    const raw = c.src.slice(start, c.i).replace(/_/g, '');
    const t = token('num', raw, line, col);
    t.num = Number(raw);
    if (Number.isNaN(t.num)) throw new CodeSyntaxError(`bad number "${raw}"`, line, col);
    return t;
  }

  while (isDigit(at(c)) || at(c) === '_') advance(c);
  if (at(c) === '.') {
    advance(c);
    while (isDigit(at(c)) || at(c) === '_') advance(c);
  }
  if (at(c) === 'e' || at(c) === 'E') {
    advance(c);
    if (at(c) === '+' || at(c) === '-') advance(c);
    if (!isDigit(at(c))) throw new CodeSyntaxError('bad exponent', c.line, c.col);
    while (isDigit(at(c))) advance(c);
  }

  const raw = c.src.slice(start, c.i).replace(/_/g, '');
  const t = token('num', raw, line, col);
  t.num = Number(raw);
  if (Number.isNaN(t.num)) throw new CodeSyntaxError(`bad number "${raw}"`, line, col);
  return t;
}

function skipTrivia(c: Cursor): boolean {
  const before = c.i;
  for (;;) {
    const ch = at(c);
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      advance(c);
      continue;
    }
    if (ch === '/' && at(c, 1) === '/') {
      while (at(c) !== '\n' && at(c) !== '') advance(c);
      continue;
    }
    if (ch === '/' && at(c, 1) === '*') {
      const line = c.line;
      const col = c.col;
      advance(c, 2);
      for (;;) {
        if (at(c) === '') throw new CodeSyntaxError('unterminated block comment', line, col);
        if (at(c) === '*' && at(c, 1) === '/') {
          advance(c, 2);
          break;
        }
        advance(c);
      }
      continue;
    }
    break;
  }
  return c.i !== before;
}

function readPunct(c: Cursor): Token {
  for (const p of PUNCT) {
    if (c.src.startsWith(p, c.i)) {
      const t = token('punct', p, c.line, c.col);
      advance(c, p.length);
      return t;
    }
  }
  throw new CodeSyntaxError(`unexpected character "${at(c)}"`, c.line, c.col);
}

/**
 * Turns source into tokens. Template literals become a run of `tmpl` chunks
 * with ordinary tokens between them, the way a real JS lexer does it — the
 * brace stack tracks which `}` closes a `${` and which closes an object.
 */
export function tokenise(src: string): Token[] {
  const c: Cursor = { src, i: 0, line: 1, col: 1 };
  const tokens: Token[] = [];
  const templateBraces: number[] = [];
  let braceDepth = 0;
  let sawNewline = false;

  const push = (t: Token): void => {
    t.nlBefore = sawNewline;
    sawNewline = false;
    tokens.push(t);
  };

  for (;;) {
    const lineBefore = c.line;
    skipTrivia(c);
    if (c.line !== lineBefore) sawNewline = true;
    const ch = at(c);
    if (ch === '') break;

    if (ch === '`') {
      advance(c);
      const t = readTemplateChunk(c, true);
      push(t);
      if (!t.tail) templateBraces.push(braceDepth);
      continue;
    }

    if (ch === '}' && templateBraces.length > 0 && templateBraces.at(-1) === braceDepth) {
      templateBraces.pop();
      advance(c);
      const t = readTemplateChunk(c, false);
      push(t);
      if (!t.tail) templateBraces.push(braceDepth);
      continue;
    }

    if (ch === '"' || ch === "'") {
      push(readString(c, ch));
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(at(c, 1)))) {
      push(readNumber(c));
      continue;
    }

    if (isIdentStart(ch)) {
      const line = c.line;
      const col = c.col;
      const start = c.i;
      while (isIdentPart(at(c))) advance(c);
      push(token('name', c.src.slice(start, c.i), line, col));
      continue;
    }

    if (ch === '{') braceDepth += 1;
    if (ch === '}') braceDepth -= 1;
    push(readPunct(c));
  }

  const eof = token('eof', '', c.line, c.col);
  eof.nlBefore = sawNewline;
  tokens.push(eof);
  return tokens;
}
