// Recursive-descent parser for the RunCode mini-language.
//
// The grammar is a subset of JavaScript chosen so that a model writing plain
// JavaScript mostly just works, while everything an escape would need —
// `new`, `class`, `function`, `import`, `require`, `eval`, `this` — is a
// syntax error with a message saying what to write instead. See lexer.ts for
// why the subset is the security boundary rather than a convenience.

import { type Expr, type Node, REFUSED_KEYWORDS, type Stmt } from './ast.ts';
import { CodeSyntaxError, type Token, tokenise } from './lexer.ts';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const LITERAL_NAMES = new Set(['true', 'false', 'null', 'undefined']);

/**
 * How deep statements and expressions may nest.
 *
 * A recursive-descent parser's real limit is the JS call stack, and reaching it
 * throws a host RangeError that is not a CodeSyntaxError — so 5000 nested
 * parentheses came back to the caller as a rejected tool call with no position
 * in it, instead of "will not parse at line 1". This bound is reached first,
 * and it is far above anything a program written to be read would use.
 */
const MAX_NESTING = 200;

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  /** Enclosing loops, so `break` outside one can be refused. Reset inside an
   *  arrow body: a loop does not extend into a function, and JavaScript calls
   *  a `break` there an illegal break statement too. */
  private loopDepth = 0;
  private nesting = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private enterNesting(): void {
    this.nesting += 1;
    if (this.nesting > MAX_NESTING) {
      const t = this.peek();
      throw new CodeSyntaxError(
        `this nests deeper than ${MAX_NESTING} levels — split it into named steps`,
        t.line,
        t.col,
      );
    }
  }

  private peek(offset = 0): Token {
    const idx = Math.min(this.pos + offset, this.tokens.length - 1);
    // tokenise always appends EOF, so the clamped index is always populated.
    return this.tokens[idx] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  private isPunct(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'punct' && t.value === value;
  }

  private isName(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'name' && t.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  private expectPunct(value: string): Token {
    if (!this.isPunct(value)) this.fail(`expected "${value}"`);
    return this.next();
  }

  private fail(message: string, tok: Token = this.peek()): never {
    const found = tok.kind === 'eof' ? 'end of program' : `"${tok.value}"`;
    throw new CodeSyntaxError(`${message} but found ${found}`, tok.line, tok.col);
  }

  /** Rejects reserved words the language does not implement, by name. */
  private checkRefused(tok: Token): void {
    const reason = REFUSED_KEYWORDS[tok.value];
    if (reason !== undefined) throw new CodeSyntaxError(reason, tok.line, tok.col);
  }

  private identName(): string {
    const t = this.peek();
    if (t.kind !== 'name') this.fail('expected a name');
    this.checkRefused(t);
    if (LITERAL_NAMES.has(t.value)) {
      throw new CodeSyntaxError(`"${t.value}" cannot be used as a name`, t.line, t.col);
    }
    this.pos += 1;
    return t.value;
  }

  // ---------------------------------------------------------------- statements

  parseProgram(): Stmt {
    const start = this.peek();
    const body: Stmt[] = [];
    while (this.peek().kind !== 'eof') body.push(this.parseStatement());
    return { type: 'Program', body, line: start.line, col: start.col };
  }

  private parseStatement(): Stmt {
    this.enterNesting();
    try {
      return this.statement();
    } finally {
      this.nesting -= 1;
    }
  }

  private statement(): Stmt {
    const t = this.peek();

    if (t.kind === 'punct' && t.value === '{') return this.parseBlock();
    if (t.kind === 'punct' && t.value === ';') {
      this.pos += 1;
      return { type: 'Block', body: [], line: t.line, col: t.col };
    }

    if (t.kind === 'name') {
      this.checkRefused(t);
      switch (t.value) {
        case 'const':
        case 'let':
          return this.parseVarDecl();
        case 'if':
          return this.parseIf();
        case 'while':
          return this.parseWhile();
        case 'for':
          return this.parseFor();
        case 'return': {
          this.pos += 1;
          const hasValue =
            !this.isPunct(';') &&
            !this.isPunct('}') &&
            this.peek().kind !== 'eof' &&
            !this.peek().nlBefore;
          const value = hasValue ? this.parseExpression() : null;
          this.eatPunct(';');
          return { type: 'Return', value, line: t.line, col: t.col };
        }
        case 'break':
        case 'continue':
          return this.parseLoopJump(t);
        default:
          break;
      }
    }

    const expr = this.parseExpression();
    this.eatPunct(';');
    return { type: 'ExprStmt', expr, line: t.line, col: t.col };
  }

  /**
   * `break` / `continue`, refused outside a loop.
   *
   * Accepting them anywhere was worse than a wrong answer: the interpreter let
   * the completion escape the whole program, so `if (!files.ok) break;` — a
   * model reaching for `return` — ended the run early and reported success,
   * with the edits it was supposed to make silently not done.
   */
  private parseLoopJump(t: Token): Stmt {
    if (this.loopDepth === 0) {
      const hint = t.value === 'break' ? ' — use `return` to stop the program' : '';
      throw new CodeSyntaxError(
        `\`${t.value}\` is only allowed inside a loop${hint}`,
        t.line,
        t.col,
      );
    }
    this.pos += 1;
    this.eatPunct(';');
    return t.value === 'break'
      ? { type: 'Break', line: t.line, col: t.col }
      : { type: 'Continue', line: t.line, col: t.col };
  }

  /** Parses a loop body with `break` and `continue` allowed inside it. */
  private parseLoopBody(): Stmt {
    this.loopDepth += 1;
    try {
      return this.parseStatement();
    } finally {
      this.loopDepth -= 1;
    }
  }

  private parseBlock(): Stmt {
    const start = this.expectPunct('{');
    const body: Stmt[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') this.fail('expected "}"');
      body.push(this.parseStatement());
    }
    this.expectPunct('}');
    return { type: 'Block', body, line: start.line, col: start.col };
  }

  private parseVarDecl(): Stmt {
    const kw = this.next();
    const kind = kw.value === 'const' ? 'const' : 'let';
    if (this.isPunct('[') || this.isPunct('{')) {
      throw new CodeSyntaxError(
        'destructuring is not supported — declare one name at a time',
        this.peek().line,
        this.peek().col,
      );
    }
    const name = this.identName();
    let init: Expr | null = null;
    if (this.eatPunct('=')) init = this.parseExpression();
    if (kind === 'const' && init === null) {
      throw new CodeSyntaxError(`const "${name}" needs a value`, kw.line, kw.col);
    }
    this.eatPunct(';');
    return { type: 'VarDecl', kind, name, init, line: kw.line, col: kw.col };
  }

  private parseIf(): Stmt {
    const kw = this.next();
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    const then = this.parseStatement();
    let other: Stmt | null = null;
    if (this.isName('else')) {
      this.pos += 1;
      other = this.parseStatement();
    }
    return { type: 'If', test, then, other, line: kw.line, col: kw.col };
  }

  private parseWhile(): Stmt {
    const kw = this.next();
    this.expectPunct('(');
    const test = this.parseExpression();
    this.expectPunct(')');
    const body = this.parseLoopBody();
    return { type: 'While', test, body, line: kw.line, col: kw.col };
  }

  private parseFor(): Stmt {
    const kw = this.next();
    this.expectPunct('(');

    const isDecl = this.isName('const') || this.isName('let');
    if (isDecl && this.peek(1).kind === 'name' && this.isName('of', 2)) {
      // The kind is kept, not discarded: binding a `let` element as a constant
      // made `for (let s of lines) { s = s.trim(); }` fail, and fail claiming
      // `s` was a const when the program plainly says otherwise.
      const kind = this.isName('const') ? 'const' : 'let';
      this.pos += 1;
      const name = this.identName();
      this.pos += 1; // `of`
      const iterable = this.parseExpression();
      this.expectPunct(')');
      const body = this.parseLoopBody();
      return { type: 'ForOf', kind, name, iterable, body, line: kw.line, col: kw.col };
    }
    if (isDecl && this.peek(1).kind === 'name' && this.isName('in', 2)) {
      throw new CodeSyntaxError(
        'for…in is not supported — use for (const k of Object.keys(o))',
        kw.line,
        kw.col,
      );
    }

    let init: Stmt | null = null;
    if (!this.isPunct(';')) {
      init = isDecl ? this.parseVarDecl() : this.parseStatement();
    } else {
      this.pos += 1;
    }
    const test = this.isPunct(';') ? null : this.parseExpression();
    this.expectPunct(';');
    const update = this.isPunct(')') ? null : this.parseExpression();
    this.expectPunct(')');
    const body = this.parseLoopBody();
    return { type: 'For', init, test, update, body, line: kw.line, col: kw.col };
  }

  // --------------------------------------------------------------- expressions

  parseExpression(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    this.enterNesting();
    try {
      return this.assignment();
    } finally {
      this.nesting -= 1;
    }
  }

  private assignment(): Expr {
    const arrow = this.tryParseArrow();
    if (arrow) return arrow;

    const left = this.parseConditional();
    const t = this.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.value)) {
      if (left.type !== 'Ident' && left.type !== 'Member') {
        throw new CodeSyntaxError('cannot assign to this expression', t.line, t.col);
      }
      this.pos += 1;
      const value = this.parseAssign();
      return { type: 'Assign', op: t.value, target: left, value, line: t.line, col: t.col };
    }
    return left;
  }

  /** `x => …` and `(a, b) => …`, distinguished from a parenthesised group by
   *  scanning ahead to the matching `)`. */
  private tryParseArrow(): Expr | null {
    const t = this.peek();

    if (t.kind === 'name' && !LITERAL_NAMES.has(t.value) && this.isPunct('=>', 1)) {
      this.checkRefused(t);
      this.pos += 2;
      return this.finishArrow([t.value], t);
    }

    if (t.kind === 'punct' && t.value === '(') {
      const close = this.matchingParen(this.pos);
      if (close < 0) return null;
      const after = this.tokens[close + 1];
      if (!after || after.kind !== 'punct' || after.value !== '=>') return null;
      this.pos += 1;
      const params: string[] = [];
      while (!this.isPunct(')')) {
        if (this.isPunct('...')) {
          throw new CodeSyntaxError(
            'rest parameters are not supported',
            this.peek().line,
            this.peek().col,
          );
        }
        params.push(this.identName());
        if (!this.eatPunct(',')) break;
      }
      this.expectPunct(')');
      this.expectPunct('=>');
      return this.finishArrow(params, t);
    }

    return null;
  }

  private finishArrow(params: string[], start: Token): Expr {
    const enclosing = this.loopDepth;
    this.loopDepth = 0;
    try {
      const body: Expr | Stmt = this.isPunct('{') ? this.parseBlock() : this.parseAssign();
      return { type: 'Arrow', params, body, line: start.line, col: start.col };
    } finally {
      this.loopDepth = enclosing;
    }
  }

  /** Index of the `)` matching the `(` at `from`, or -1. */
  private matchingParen(from: number): number {
    let depth = 0;
    for (let i = from; i < this.tokens.length; i += 1) {
      const t = this.tokens[i];
      if (!t || t.kind === 'eof') return -1;
      if (t.kind !== 'punct') continue;
      if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
      else if (t.value === ')' || t.value === ']' || t.value === '}') {
        depth -= 1;
        if (depth === 0) return i;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  private parseConditional(): Expr {
    const test = this.parseBinary(0);
    if (!this.isPunct('?')) return test;
    const q = this.next();
    const then = this.parseAssign();
    this.expectPunct(':');
    const other = this.parseAssign();
    return { type: 'Cond', test, then, other, line: q.line, col: q.col };
  }

  /** Precedence climbing over the binary operator table. */
  private parseBinary(minLevel: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct') break;
      if (t.value === '==' || t.value === '!=') {
        throw new CodeSyntaxError(
          `"${t.value}" is not supported — use "${t.value === '==' ? '===' : '!=='}"`,
          t.line,
          t.col,
        );
      }
      const level = BINARY_LEVELS[t.value];
      if (level === undefined || level < minLevel) break;
      this.pos += 1;
      // `**` is the one right-associative operator, so it recurses at its own
      // level rather than one above it.
      const right = this.parseBinary(t.value === '**' ? level : level + 1);
      left =
        t.value === '&&' || t.value === '||' || t.value === '??'
          ? { type: 'Logical', op: t.value, left, right, line: t.line, col: t.col }
          : { type: 'Binary', op: t.value, left, right, line: t.line, col: t.col };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'punct' && (t.value === '!' || t.value === '-' || t.value === '+')) {
      this.pos += 1;
      return {
        type: 'Unary',
        op: t.value,
        arg: this.parseUnary(),
        line: t.line,
        col: t.col,
      };
    }
    if (t.kind === 'punct' && (t.value === '++' || t.value === '--')) {
      this.pos += 1;
      const target = this.parseUnary();
      if (target.type !== 'Ident' && target.type !== 'Member') {
        throw new CodeSyntaxError(`cannot apply ${t.value} here`, t.line, t.col);
      }
      return { type: 'Update', op: t.value, prefix: true, target, line: t.line, col: t.col };
    }
    if (t.kind === 'name' && t.value === 'typeof') {
      this.pos += 1;
      return { type: 'Unary', op: 'typeof', arg: this.parseUnary(), line: t.line, col: t.col };
    }
    if (t.kind === 'name' && t.value === 'await') {
      // Tool calls already complete before they return a value, so `await` is
      // accepted and ignored rather than refused — a model that writes it out
      // of habit should not get a syntax error for being idiomatic.
      this.pos += 1;
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    const expr = this.parseCallMember();
    const t = this.peek();
    if (t.kind === 'punct' && (t.value === '++' || t.value === '--') && !t.nlBefore) {
      if (expr.type !== 'Ident' && expr.type !== 'Member') {
        throw new CodeSyntaxError(`cannot apply ${t.value} here`, t.line, t.col);
      }
      this.pos += 1;
      return { type: 'Update', op: t.value, prefix: false, target: expr, line: t.line, col: t.col };
    }
    return expr;
  }

  private parseCallMember(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct') break;

      if (t.value === '.' || t.value === '?.') {
        const optional = t.value === '?.';
        this.pos += 1;
        // `a?.()` and `a?.[i]` keep the optional flag but continue as call/index.
        if (optional && this.isPunct('(')) {
          expr = this.finishCall(expr, true);
          continue;
        }
        if (optional && this.isPunct('[')) {
          expr = this.finishIndex(expr, true);
          continue;
        }
        const nameTok = this.peek();
        if (nameTok.kind !== 'name') this.fail('expected a property name');
        this.pos += 1;
        expr = {
          type: 'Member',
          object: expr,
          property: { type: 'Str', value: nameTok.value, line: nameTok.line, col: nameTok.col },
          computed: false,
          optional,
          line: nameTok.line,
          col: nameTok.col,
        };
        continue;
      }

      // The restricted production: a `(` or `[` on a new line starts a new
      // statement rather than continuing this one. Semicolons are optional and
      // this is what keeps that from silently changing a program's meaning.
      if (t.value === '(' && !t.nlBefore) {
        expr = this.finishCall(expr, false);
        continue;
      }
      if (t.value === '[' && !t.nlBefore) {
        expr = this.finishIndex(expr, false);
        continue;
      }
      break;
    }
    return expr;
  }

  private finishCall(callee: Expr, optional: boolean): Expr {
    const open = this.expectPunct('(');
    const args: Expr[] = [];
    while (!this.isPunct(')')) {
      if (this.isPunct('...')) {
        throw new CodeSyntaxError(
          'spread arguments are not supported',
          this.peek().line,
          this.peek().col,
        );
      }
      args.push(this.parseAssign());
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct(')');
    return { type: 'Call', callee, args, optional, line: open.line, col: open.col };
  }

  private finishIndex(object: Expr, optional: boolean): Expr {
    const open = this.expectPunct('[');
    const property = this.parseExpression();
    this.expectPunct(']');
    return {
      type: 'Member',
      object,
      property,
      computed: true,
      optional,
      line: open.line,
      col: open.col,
    };
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === 'num') {
      this.pos += 1;
      return { type: 'Num', value: t.num, line: t.line, col: t.col };
    }
    if (t.kind === 'str') {
      this.pos += 1;
      return { type: 'Str', value: t.value, line: t.line, col: t.col };
    }
    if (t.kind === 'tmpl') return this.parseTemplate();

    if (t.kind === 'name') {
      this.checkRefused(t);
      this.pos += 1;
      if (t.value === 'true') return { type: 'Bool', value: true, line: t.line, col: t.col };
      if (t.value === 'false') return { type: 'Bool', value: false, line: t.line, col: t.col };
      if (t.value === 'null' || t.value === 'undefined') {
        return { type: 'Null', line: t.line, col: t.col };
      }
      return { type: 'Ident', name: t.value, line: t.line, col: t.col };
    }

    if (t.kind === 'punct') {
      if (t.value === '(') {
        this.pos += 1;
        const inner = this.parseExpression();
        this.expectPunct(')');
        return inner;
      }
      if (t.value === '[') return this.parseArray();
      if (t.value === '{') return this.parseObject();
    }

    this.fail('expected an expression');
  }

  private parseTemplate(): Expr {
    const start = this.peek();
    const quasis: string[] = [];
    const exprs: Expr[] = [];
    for (;;) {
      const chunk = this.peek();
      if (chunk.kind !== 'tmpl') this.fail('malformed template literal');
      this.pos += 1;
      quasis.push(chunk.value);
      if (chunk.tail) break;
      exprs.push(this.parseExpression());
    }
    return { type: 'Tmpl', quasis, exprs, line: start.line, col: start.col };
  }

  private parseArray(): Expr {
    const open = this.expectPunct('[');
    const items: Expr[] = [];
    while (!this.isPunct(']')) {
      if (this.isPunct('...')) {
        throw new CodeSyntaxError('spread is not supported', this.peek().line, this.peek().col);
      }
      items.push(this.parseAssign());
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct(']');
    return { type: 'Arr', items, line: open.line, col: open.col };
  }

  private parseObject(): Expr {
    const open = this.expectPunct('{');
    const props: Array<{ key: string; value: Expr }> = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        throw new CodeSyntaxError('spread is not supported', this.peek().line, this.peek().col);
      }
      if (this.isPunct('[')) {
        throw new CodeSyntaxError(
          'computed keys are not supported',
          this.peek().line,
          this.peek().col,
        );
      }
      const keyTok = this.peek();
      let key: string;
      if (keyTok.kind === 'str') {
        key = keyTok.value;
        this.pos += 1;
      } else if (keyTok.kind === 'num') {
        key = String(keyTok.num);
        this.pos += 1;
      } else if (keyTok.kind === 'name') {
        key = keyTok.value;
        this.pos += 1;
      } else {
        this.fail('expected a property name');
      }

      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new CodeSyntaxError(`"${key}" is not an allowed key`, keyTok.line, keyTok.col);
      }

      if (this.eatPunct(':')) {
        props.push({ key, value: this.parseAssign() });
      } else if (keyTok.kind === 'name') {
        // Shorthand `{ path, count }`.
        this.checkRefused(keyTok);
        props.push({
          key,
          value: { type: 'Ident', name: key, line: keyTok.line, col: keyTok.col },
        });
      } else {
        this.fail('expected ":"');
      }
      if (!this.eatPunct(',')) break;
    }
    this.expectPunct('}');
    return { type: 'Obj', props, line: open.line, col: open.col };
  }
}

/** Binary operator precedence. Higher binds tighter. */
const BINARY_LEVELS: Readonly<Record<string, number>> = {
  '??': 1,
  '||': 1,
  '&&': 2,
  '===': 3,
  '!==': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
  '**': 7,
};

/** Parses a program, throwing CodeSyntaxError with a position on failure. */
export function parseProgram(src: string): Node {
  return new Parser(tokenise(src)).parseProgram();
}

export { CodeSyntaxError } from './lexer.ts';
