// Tree-walking evaluator for the RunCode mini-language.
//
// Why an interpreter and not `node:vm`
// ------------------------------------
// A `vm` context looks like a sandbox and is not one. Give it a single host
// callable — which a tool bridge must — and the script has the host realm:
//
//     vm.createContext({ callTool });
//     callTool.constructor('return [process.env.API_KEY,
//        typeof process.getBuiltinModule("node:fs").writeFileSync]')()
//
// That was run against this project's Node and returned the environment
// variable's real value and `'function'`. `process.env` is every secret in the
// environment; `fs.writeFileSync` is every write that write-policy.ts and
// bubblewrap exist to bound. A vm-based RunCode would therefore not "inherit"
// the permission gate, it would route around the whole thing — the one design
// constraint this feature had.
//
// So the program never becomes JavaScript. It is parsed into the AST in
// ast.ts and evaluated here, where the only things it can reach are the
// whitelist in builtins.ts and the tool bridge. There is no host object graph
// to walk, so there is no escape to find. The cost is honest and worth
// stating: this is a subset, not JavaScript, and a program using something
// outside it gets a syntax error rather than a surprise.
//
// Every budget lives on `Budget` in values.ts and is charged here.

import type { Expr, Node, Stmt } from './ast.ts';
import { getMember, globalBindings, makeObject, setMember } from './builtins.ts';
import { CodeSyntaxError, parseProgram } from './parser.ts';
import {
  Budget,
  Closure,
  CodeLimitError,
  CodeRuntimeError,
  Env,
  type LimitKind,
  type Limits,
  Namespace,
  NativeFn,
  type RunCtx,
  type Value,
  display,
  isCallable,
  truthy,
  typeName,
  yieldIfDue,
} from './values.ts';

/** What a tool call looks like from the interpreter's side of the bridge. */
export type ToolBridge = (
  name: string,
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; output: string }>;

export interface RunOptions {
  limits: Limits;
  bridge: ToolBridge;
  signal?: AbortSignal;
}

export interface ToolCallRecord {
  index: number;
  name: string;
  ok: boolean;
  line: number;
  /** Failure text, trimmed. Empty for successful calls. */
  detail: string;
}

export interface RunError {
  kind: 'syntax' | 'runtime' | 'limit';
  message: string;
  line: number | null;
  col: number | null;
  limit: LimitKind | null;
}

export interface RunOutcome {
  ok: boolean;
  /** Value of a top-level `return`, or null. */
  value: Value;
  log: string[];
  logTruncated: boolean;
  calls: ToolCallRecord[];
  steps: number;
  error: RunError | null;
}

type Completion =
  | { kind: 'normal' }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'return'; value: Value };

const NORMAL: Completion = { kind: 'normal' };
const BREAK: Completion = { kind: 'break' };
const CONTINUE: Completion = { kind: 'continue' };

/** Converts an interpreter value into a plain JS structure for a tool's input.
 *  Callables and namespaces are dropped: a tool schema has no place for them,
 *  and passing one across the bridge would hand a tool an interpreter object. */
function toPlain(v: Value): unknown {
  if (v === null || typeof v !== 'object') {
    return isCallable(v) ? undefined : v;
  }
  if (v instanceof Namespace || isCallable(v)) return undefined;
  if (Array.isArray(v)) return v.map(toPlain);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v)) {
    const converted = toPlain(v[key] ?? null);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

class Interpreter {
  private readonly budget: Budget;
  private readonly bridge: ToolBridge;
  private readonly limits: Limits;
  private readonly logLines: string[] = [];
  private logChars = 0;
  private logTruncated = false;
  private readonly calls: ToolCallRecord[] = [];
  private readonly ctx: RunCtx;

  constructor(options: RunOptions) {
    this.limits = options.limits;
    this.budget = new Budget(options.limits, options.signal);
    this.bridge = options.bridge;
    this.ctx = {
      budget: this.budget,
      log: (text) => this.appendLog(text),
      callValue: (fn, args, node) => this.callValue(fn, args, node),
      callTool: (name, input, node) => this.callTool(name, input, node),
    };
  }

  /**
   * Hands the event loop back periodically, so a loop in a program does not
   * starve the runtime's I/O. Without this, every step is a microtask, stdin is
   * never read, and the REPL's ESC cannot abort a running program at all — see
   * YIELD_INTERVAL in values.ts. Called from the three loop statements, which
   * are the only unbounded constructs the language has.
   */
  private async maybeYield(): Promise<void> {
    const pause = yieldIfDue(this.budget);
    if (pause) await pause;
  }

  private appendLog(text: string): void {
    if (this.logTruncated) return;
    if (this.logChars + text.length > this.limits.maxLogChars) {
      this.logTruncated = true;
      this.logLines.push('[log truncated]');
      return;
    }
    this.logChars += text.length;
    this.logLines.push(text);
  }

  private globalEnv(): Env {
    const env = new Env(null);
    for (const [name, value] of globalBindings()) env.declare(name, value, true);
    env.declare(
      'tool',
      new NativeFn('tool', async (args, ctx, node) => {
        const name = args[0] ?? null;
        if (typeof name !== 'string') {
          throw new CodeRuntimeError(
            `tool() expects a tool name as its first argument, got ${typeName(name)}`,
            node,
          );
        }
        return ctx.callTool(name, args[1] ?? null, node);
      }),
      true,
    );
    env.declare(
      'log',
      new NativeFn('log', (args, ctx) => {
        ctx.log(args.map((a) => display(a)).join(' '));
        return null;
      }),
      true,
    );
    return env;
  }

  async run(source: string): Promise<RunOutcome> {
    let program: Node;
    try {
      program = parseProgram(source);
    } catch (e) {
      if (e instanceof CodeSyntaxError) {
        return this.outcome(null, {
          kind: 'syntax',
          message: e.message,
          line: e.line,
          col: e.col,
          limit: null,
        });
      }
      // The contract below is absolute: a program that will not parse comes
      // back as a result, never as a rejected tool call. Anything the lexer or
      // the parser throws that is not a CodeSyntaxError is a bug in them, and
      // the caller still gets a usable answer rather than "tool execution
      // error" with the position thrown away.
      return this.outcome(null, {
        kind: 'syntax',
        message: `program could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
        line: null,
        col: null,
        limit: null,
      });
    }

    try {
      const completion = await this.execStmt(program as Stmt, this.globalEnv());
      return this.outcome(completion.kind === 'return' ? completion.value : null, null);
    } catch (e) {
      return this.outcome(null, describeError(e));
    }
  }

  private outcome(value: Value, error: RunError | null): RunOutcome {
    return {
      ok: error === null,
      value,
      log: this.logLines,
      logTruncated: this.logTruncated,
      calls: this.calls,
      steps: this.budget.steps,
      error,
    };
  }

  // ------------------------------------------------------------- statements

  private async execStmt(node: Stmt, env: Env): Promise<Completion> {
    this.budget.tick();

    switch (node.type) {
      case 'Program':
      case 'Block': {
        // A block gets its own scope so `let` inside a loop body does not leak.
        const scope = node.type === 'Block' ? new Env(env) : env;
        for (const stmt of node.body) {
          const c = await this.execStmt(stmt, scope);
          if (c.kind !== 'normal') return c;
        }
        return NORMAL;
      }

      case 'VarDecl': {
        if (env.has(node.name)) {
          throw new CodeRuntimeError(`"${node.name}" is already declared here`, node);
        }
        const value = node.init ? await this.evalExpr(node.init, env) : null;
        env.declare(node.name, value, node.kind === 'const');
        return NORMAL;
      }

      case 'ExprStmt':
        await this.evalExpr(node.expr, env);
        return NORMAL;

      case 'If':
        if (truthy(await this.evalExpr(node.test, env))) return this.execStmt(node.then, env);
        if (node.other) return this.execStmt(node.other, env);
        return NORMAL;

      case 'While':
        for (;;) {
          this.budget.tick();
          await this.maybeYield();
          if (!truthy(await this.evalExpr(node.test, env))) return NORMAL;
          const c = await this.execStmt(node.body, new Env(env));
          if (c.kind === 'break') return NORMAL;
          if (c.kind === 'return') return c;
        }

      case 'ForOf': {
        const iterable = await this.evalExpr(node.iterable, env);
        const items = iterationItems(iterable, node);
        for (const item of items) {
          this.budget.tick();
          await this.maybeYield();
          const scope = new Env(env);
          scope.declare(node.name, item, node.kind === 'const');
          const c = await this.execStmt(node.body, scope);
          if (c.kind === 'break') return NORMAL;
          if (c.kind === 'return') return c;
        }
        return NORMAL;
      }

      case 'For': {
        let outer = new Env(env);
        if (node.init) await this.execStmt(node.init, outer);
        // `let` in a C-style for is one binding *per iteration*, which is what
        // makes `for (let i = 0; …) fns.push(() => i)` close over 0, 1, 2. One
        // shared binding made every closure see the final value instead — a
        // wrong answer with nothing to indicate it.
        const perIteration = node.init?.type === 'VarDecl' && node.init.kind === 'let';
        const name = node.init?.type === 'VarDecl' ? node.init.name : '';
        for (;;) {
          this.budget.tick();
          await this.maybeYield();
          if (node.test && !truthy(await this.evalExpr(node.test, outer))) return NORMAL;
          const c = await this.execStmt(node.body, new Env(outer));
          if (c.kind === 'break') return NORMAL;
          if (c.kind === 'return') return c;
          if (perIteration) outer = copyBinding(env, outer, name);
          if (node.update) await this.evalExpr(node.update, outer);
        }
      }

      case 'Return':
        return { kind: 'return', value: node.value ? await this.evalExpr(node.value, env) : null };

      case 'Break':
        return BREAK;

      case 'Continue':
        return CONTINUE;

      default:
        throw new CodeRuntimeError('unsupported statement', node);
    }
  }

  // ------------------------------------------------------------ expressions

  private async evalExpr(node: Expr, env: Env): Promise<Value> {
    this.budget.tick();

    switch (node.type) {
      case 'Num':
        return node.value;
      case 'Str':
        return node.value;
      case 'Bool':
        return node.value;
      case 'Null':
        return null;

      case 'Tmpl': {
        let out = node.quasis[0] ?? '';
        for (let i = 0; i < node.exprs.length; i += 1) {
          const piece = node.exprs[i];
          if (!piece) continue;
          out += display(await this.evalExpr(piece, env));
          out += node.quasis[i + 1] ?? '';
          this.budget.checkString(out.length);
        }
        return out;
      }

      case 'Ident': {
        const binding = env.lookup(node.name);
        if (!binding) throw new CodeRuntimeError(`"${node.name}" is not defined`, node);
        return binding.value;
      }

      case 'Arr': {
        const out: Value[] = [];
        for (const item of node.items) out.push(await this.evalExpr(item, env));
        this.budget.checkArray(out.length);
        return out;
      }

      case 'Obj': {
        const out = makeObject();
        for (const prop of node.props) out[prop.key] = await this.evalExpr(prop.value, env);
        return out;
      }

      case 'Arrow':
        return new Closure(node.params, node.body, env);

      case 'Unary': {
        const v = await this.evalExpr(node.arg, env);
        if (node.op === '!') return !truthy(v);
        if (node.op === 'typeof') return jsTypeof(v);
        if (typeof v !== 'number') {
          throw new CodeRuntimeError(`unary ${node.op} expects a number, got ${typeName(v)}`, node);
        }
        return node.op === '-' ? -v : v;
      }

      case 'Logical': {
        const left = await this.evalExpr(node.left, env);
        if (node.op === '&&') return truthy(left) ? this.evalExpr(node.right, env) : left;
        if (node.op === '||') return truthy(left) ? left : this.evalExpr(node.right, env);
        return left === null ? this.evalExpr(node.right, env) : left;
      }

      case 'Binary':
        return this.evalBinary(node, env);

      case 'Cond':
        return truthy(await this.evalExpr(node.test, env))
          ? this.evalExpr(node.then, env)
          : this.evalExpr(node.other, env);

      case 'Member':
      case 'Call':
        return (await this.evalChain(node, env)).value;

      case 'Assign':
        return this.evalAssign(node, env);

      case 'Update': {
        const ref = await this.resolveRef(node.target, env);
        const before = this.readRef(ref, env, node.target);
        if (typeof before !== 'number') {
          throw new CodeRuntimeError(`${node.op} expects a number, got ${typeName(before)}`, node);
        }
        const after = node.op === '++' ? before + 1 : before - 1;
        this.writeRef(ref, after, env, node.target);
        return node.prefix ? after : before;
      }

      default:
        throw new CodeRuntimeError('unsupported expression', node);
    }
  }

  private async memberKey(node: Extract<Expr, { type: 'Member' }>, env: Env): Promise<string> {
    if (!node.computed) {
      // The parser stores a non-computed property as a Str node.
      return node.property.type === 'Str' ? node.property.value : '';
    }
    const raw = await this.evalExpr(node.property, env);
    if (typeof raw === 'number') return String(raw);
    if (typeof raw === 'string') return raw;
    throw new CodeRuntimeError(`index must be a string or number, got ${typeName(raw)}`, node);
  }

  private async evalBinary(node: Extract<Expr, { type: 'Binary' }>, env: Env): Promise<Value> {
    const left = await this.evalExpr(node.left, env);
    const right = await this.evalExpr(node.right, env);

    switch (node.op) {
      case '===':
        return left === right;
      case '!==':
        return left !== right;
      case '+': {
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        if (typeof left === 'string' || typeof right === 'string') {
          const out = display(left) + display(right);
          this.budget.checkString(out.length);
          return out;
        }
        throw new CodeRuntimeError(`cannot add ${typeName(left)} and ${typeName(right)}`, node);
      }
      case '<':
      case '>':
      case '<=':
      case '>=': {
        if (typeof left === 'number' && typeof right === 'number') {
          return compare(node.op, left, right);
        }
        if (typeof left === 'string' && typeof right === 'string') {
          return compare(node.op, left, right);
        }
        throw new CodeRuntimeError(
          `cannot compare ${typeName(left)} with ${typeName(right)}`,
          node,
        );
      }
      default: {
        if (typeof left !== 'number' || typeof right !== 'number') {
          throw new CodeRuntimeError(
            `${node.op} expects numbers, got ${typeName(left)} and ${typeName(right)}`,
            node,
          );
        }
        if (node.op === '-') return left - right;
        if (node.op === '*') return left * right;
        if (node.op === '/') return left / right;
        if (node.op === '%') return left % right;
        if (node.op === '**') return left ** right;
        throw new CodeRuntimeError(`unsupported operator ${node.op}`, node);
      }
    }
  }

  private async evalAssign(node: Extract<Expr, { type: 'Assign' }>, env: Env): Promise<Value> {
    const ref = await this.resolveRef(node.target, env);
    let value: Value;
    if (node.op === '=') {
      value = await this.evalExpr(node.value, env);
    } else {
      const current = this.readRef(ref, env, node.target);
      const operand = await this.evalExpr(node.value, env);
      value = this.applyCompound(node.op, current, operand, node);
    }
    this.writeRef(ref, value, env, node.target);
    return value;
  }

  private applyCompound(op: string, current: Value, operand: Value, node: Node): Value {
    if (op === '+=') {
      if (typeof current === 'number' && typeof operand === 'number') return current + operand;
      if (typeof current === 'string' || typeof operand === 'string') {
        const out = display(current) + display(operand);
        this.budget.checkString(out.length);
        return out;
      }
      throw new CodeRuntimeError(`cannot add ${typeName(current)} and ${typeName(operand)}`, node);
    }
    if (typeof current !== 'number' || typeof operand !== 'number') {
      throw new CodeRuntimeError(
        `${op} expects numbers, got ${typeName(current)} and ${typeName(operand)}`,
        node,
      );
    }
    if (op === '-=') return current - operand;
    if (op === '*=') return current * operand;
    if (op === '/=') return current / operand;
    if (op === '%=') return current % operand;
    throw new CodeRuntimeError(`unsupported operator ${op}`, node);
  }

  /**
   * Resolves an assignment target to the place it names, evaluating the target
   * exactly once.
   *
   * `evalAssign` and `Update` used to evaluate the target to read it and then
   * evaluate it again to write it. For `obj.n += 1` that is invisible; for
   * `tool('Bash', {…}).n += 1` it runs the command twice and spends two calls
   * from a budget the program was told it had one of.
   */
  private async resolveRef(target: Expr, env: Env): Promise<Ref> {
    if (target.type === 'Ident') return { kind: 'var', name: target.name };
    if (target.type === 'Member') {
      const object = await this.evalExpr(target.object, env);
      const key = await this.memberKey(target, env);
      return { kind: 'member', object, key };
    }
    throw new CodeRuntimeError('cannot assign to this expression', target);
  }

  private readRef(ref: Ref, env: Env, node: Node): Value {
    if (ref.kind === 'member') return getMember(ref.object, ref.key, node);
    const binding = env.lookup(ref.name);
    if (!binding) throw new CodeRuntimeError(`"${ref.name}" is not defined`, node);
    return binding.value;
  }

  private writeRef(ref: Ref, value: Value, env: Env, node: Node): void {
    if (ref.kind === 'member') {
      setMember(ref.object, ref.key, value, node, this.budget);
      return;
    }
    const binding = env.lookup(ref.name);
    if (!binding) throw new CodeRuntimeError(`"${ref.name}" is not defined`, node);
    if (binding.constant) {
      throw new CodeRuntimeError(`"${ref.name}" is a const and cannot be reassigned`, node);
    }
    binding.value = value;
  }

  /**
   * One link of a member/call chain.
   *
   * `optional` was a property of a single node, so `?.` guarded only the access
   * written next to it: `r?.data.items` read `data` off null and failed, where
   * JavaScript answers undefined for the whole chain. Short-circuiting has to
   * propagate outwards, so it is carried in the result rather than inferred
   * from the value — null is a value a chain can legitimately produce.
   */
  private async evalChain(node: Expr, env: Env): Promise<Chain> {
    if (node.type === 'Member') {
      const base = await this.evalChainBase(node.object, env);
      if (base.short || (node.optional && base.value === null)) return SHORT_CIRCUIT;
      const key = await this.memberKey(node, env);
      return { value: getMember(base.value, key, node), short: false };
    }
    if (node.type === 'Call') {
      const callee = await this.evalChainBase(node.callee, env);
      if (callee.short || (node.optional && callee.value === null)) return SHORT_CIRCUIT;
      const args: Value[] = [];
      for (const a of node.args) args.push(await this.evalExpr(a, env));
      return { value: await this.callValue(callee.value, args, node), short: false };
    }
    throw new CodeRuntimeError('unsupported expression', node);
  }

  /** The thing a chain link is applied to. Ticks for the link it continues,
   *  because `evalExpr` only charged for the outermost node of a chain. */
  private async evalChainBase(node: Expr, env: Env): Promise<Chain> {
    if (node.type !== 'Member' && node.type !== 'Call') {
      return { value: await this.evalExpr(node, env), short: false };
    }
    this.budget.tick();
    return this.evalChain(node, env);
  }

  async callValue(fn: Value, args: Value[], node: Node): Promise<Value> {
    if (fn instanceof NativeFn) {
      return (await fn.impl(args, this.ctx, node)) ?? null;
    }
    if (fn instanceof Closure) {
      this.budget.enterCall();
      try {
        const scope = new Env(fn.env);
        fn.params.forEach((name, i) => scope.declare(name, args[i] ?? null, false));
        if (isStatement(fn.body)) {
          const c = await this.execStmt(fn.body, scope);
          return c.kind === 'return' ? c.value : null;
        }
        return await this.evalExpr(fn.body, scope);
      } finally {
        this.budget.exitCall();
      }
    }
    throw new CodeRuntimeError(`${typeName(fn)} is not a function`, node);
  }

  /**
   * The bridge. Every call is charged against the call budget and the clock
   * before it starts, so a program cannot begin a new tool call after its time
   * is up, and cannot make an unbounded number of them.
   */
  async callTool(name: string, input: Value, node: Node): Promise<Value> {
    this.budget.checkClock();
    this.budget.chargeToolCall();

    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) {
      throw new CodeRuntimeError(
        `tool("${name}", …) expects an object of inputs, got ${typeName(input)}`,
        node,
      );
    }
    const plain = (input === null ? {} : toPlain(input)) as Record<string, unknown>;

    const result = await this.bridge(name, plain);
    // Re-check afterwards so a program whose deadline expired *during* a call
    // stops here rather than starting more work.
    this.budget.checkClock();

    const output =
      result.output.length > this.limits.maxToolOutputChars
        ? `${result.output.slice(0, this.limits.maxToolOutputChars)}\n[truncated]`
        : result.output;

    this.calls.push({
      index: this.calls.length + 1,
      name,
      ok: result.ok,
      line: node.line,
      detail: result.ok ? '' : output.slice(0, 300).trim(),
    });

    const value = makeObject();
    value['ok'] = result.ok;
    value['output'] = output;
    value['tool'] = name;
    return value;
  }
}

/** Where an assignment writes: a binding by name, or a resolved member. */
type Ref = { kind: 'var'; name: string } | { kind: 'member'; object: Value; key: string };

/** The result of one chain link, and whether an earlier `?.` cut the chain. */
interface Chain {
  value: Value;
  short: boolean;
}

const SHORT_CIRCUIT: Chain = { value: null, short: true };

/** A fresh scope carrying the loop variable's current value, so each iteration
 *  of a C-style `for (let …)` closes over its own binding. */
function copyBinding(parent: Env, from: Env, name: string): Env {
  const fresh = new Env(parent);
  fresh.declare(name, from.lookup(name)?.value ?? null, false);
  return fresh;
}

function isStatement(node: Node): node is Stmt {
  return node.type === 'Block' || node.type === 'Program';
}

function compare(op: string, a: number | string, b: number | string): boolean {
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  if (op === '<=') return a <= b;
  return a >= b;
}

function jsTypeof(v: Value): string {
  if (v === null) return 'object';
  if (isCallable(v)) return 'function';
  if (Array.isArray(v)) return 'object';
  if (v instanceof Namespace) return 'object';
  return typeof v;
}

function iterationItems(iterable: Value, node: Node): Value[] {
  if (Array.isArray(iterable)) return [...iterable];
  if (typeof iterable === 'string') return [...iterable];
  throw new CodeRuntimeError(`for…of expects an array or string, got ${typeName(iterable)}`, node);
}

function describeError(e: unknown): RunError {
  if (e instanceof CodeLimitError) {
    return { kind: 'limit', message: e.message, line: null, col: null, limit: e.kind };
  }
  if (e instanceof CodeRuntimeError) {
    return { kind: 'runtime', message: e.message, line: e.line, col: e.col, limit: null };
  }
  if (e instanceof CodeSyntaxError) {
    return { kind: 'syntax', message: e.message, line: e.line, col: e.col, limit: null };
  }
  // A bug in the interpreter, or a tool that threw instead of returning an
  // error result. Either way the program's caller gets a result, not a crash.
  return {
    kind: 'runtime',
    message: e instanceof Error ? e.message : String(e),
    line: null,
    col: null,
    limit: null,
  };
}

/** Parses and evaluates `source`. Never throws — every failure comes back as
 *  `outcome.error` so the tool can turn it into a usable tool result. */
export async function runProgram(source: string, options: RunOptions): Promise<RunOutcome> {
  return new Interpreter(options).run(source);
}

export type { Limits } from './values.ts';
