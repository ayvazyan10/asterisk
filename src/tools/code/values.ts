// Runtime values, scopes, budgets and errors for the RunCode mini-language.
//
// Two things here are load-bearing for the boundary rather than for tidiness:
//
//   * `Closure`, `NativeFn` and `Namespace` are classes, checked with
//     `instanceof`. A program can build objects and arrays but has no way to
//     construct a class instance, so it cannot forge a callable and hand the
//     evaluator an AST of its own choosing.
//   * Object literals are created with `Object.create(null)`. Combined with the
//     own-property check in the interpreter's member access, that means
//     `({}).constructor` is undefined rather than the host `Object` — which is
//     the first step of every `vm` escape.

import type { Node } from './ast.ts';

export type Value = null | boolean | number | string | Value[] | ValueObject | Callable | Namespace;

/** An interface rather than a `Record` alias: the alias made `Value` a type
 *  that circularly references itself, which TypeScript rejects. */
export interface ValueObject {
  [key: string]: Value;
}

export type Callable = Closure | NativeFn;

/** A user-defined arrow function, closed over its defining scope. */
export class Closure {
  readonly params: readonly string[];
  readonly body: Node;
  readonly env: Env;

  constructor(params: readonly string[], body: Node, env: Env) {
    this.params = params;
    this.body = body;
    this.env = env;
  }
}

export type NativeImpl = (args: Value[], ctx: RunCtx, node: Node) => Value | Promise<Value>;

/** A builtin. The host function never reaches the program: member access
 *  returns a fresh `NativeFn` wrapper, and the program can only *call* it. */
export class NativeFn {
  readonly name: string;
  readonly impl: NativeImpl;

  constructor(name: string, impl: NativeImpl) {
    this.name = name;
    this.impl = impl;
  }
}

/** A builtin namespace such as `JSON` or `Math` — a fixed, whitelisted map. */
export class Namespace {
  readonly name: string;
  readonly members: ReadonlyMap<string, Value>;

  constructor(name: string, members: ReadonlyMap<string, Value>) {
    this.name = name;
    this.members = members;
  }
}

export interface Binding {
  value: Value;
  constant: boolean;
}

export class Env {
  private readonly vars = new Map<string, Binding>();
  private readonly parent: Env | null;

  constructor(parent: Env | null = null) {
    this.parent = parent;
  }

  declare(name: string, value: Value, constant: boolean): void {
    this.vars.set(name, { value, constant });
  }

  lookup(name: string): Binding | undefined {
    let scope: Env | null = this;
    while (scope) {
      const found = scope.vars.get(name);
      if (found) return found;
      scope = scope.parent;
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }
}

// ------------------------------------------------------------------- errors

export class CodeRuntimeError extends Error {
  readonly line: number;
  readonly col: number;

  constructor(message: string, node: Node) {
    super(message);
    this.name = 'CodeRuntimeError';
    this.line = node.line;
    this.col = node.col;
  }
}

export type LimitKind = 'steps' | 'time' | 'tool-calls' | 'depth' | 'size' | 'aborted';

/** A budget was exhausted. Distinct from CodeRuntimeError because the program
 *  did nothing wrong — it was stopped, and the result says so. */
export class CodeLimitError extends Error {
  readonly kind: LimitKind;

  constructor(kind: LimitKind, message: string) {
    super(message);
    this.name = 'CodeLimitError';
    this.kind = kind;
  }
}

// ------------------------------------------------------------------ budgets

export interface Limits {
  /** Interpreter steps. Bounds a loop that makes no tool calls at all. */
  maxSteps: number;
  maxToolCalls: number;
  /** Arrow-function call depth; bounds runaway recursion before the JS stack. */
  maxDepth: number;
  /** Epoch milliseconds after which the program is stopped. */
  deadline: number;
  maxLogChars: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxToolOutputChars: number;
}

/** How often the wall clock and the abort signal are consulted. Checking every
 *  step would put a `Date.now()` in the hot path of the interpreter; at this
 *  cadence a runaway loop still notices within a millisecond or so. */
const CLOCK_CHECK_INTERVAL = 512;

/**
 * How often the interpreter hands the event loop back.
 *
 * Not an optimisation — a correctness fix. Every evaluation step is an `await`
 * of an already-settled promise, which schedules a *microtask*, and microtasks
 * drain completely before the runtime looks at timers or I/O. So a tight loop
 * in a program starves the event loop: the REPL's keypress handler never runs,
 * `controller.abort()` is never called, and ESC does nothing until the program
 * ends on its own. Yielding to a macrotask on this cadence lets stdin be read.
 * Measured at ~4ms of added latency per million steps.
 */
const YIELD_INTERVAL = 10_000;

export class Budget {
  readonly limits: Limits;
  private readonly signal: AbortSignal | undefined;
  steps = 0;
  toolCalls = 0;
  depth = 0;
  private sinceClockCheck = 0;
  private sinceYield = 0;

  constructor(limits: Limits, signal?: AbortSignal) {
    this.limits = limits;
    this.signal = signal;
  }

  /** Charged once per evaluated node. Throws when a budget runs out. */
  tick(): void {
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) {
      throw new CodeLimitError(
        'steps',
        `program exceeded ${this.limits.maxSteps} evaluation steps — it is probably looping without end`,
      );
    }
    this.sinceClockCheck += 1;
    if (this.sinceClockCheck >= CLOCK_CHECK_INTERVAL) {
      this.sinceClockCheck = 0;
      this.checkClock();
    }
    this.sinceYield += 1;
  }

  /** True once per YIELD_INTERVAL steps. Sync so the caller only pays for a
   *  promise on the rare iteration that actually yields. */
  dueForYield(): boolean {
    if (this.sinceYield < YIELD_INTERVAL) return false;
    this.sinceYield = 0;
    return true;
  }

  /** Consulted directly around tool calls, where a single step can take
   *  seconds and the step-cadence check would not fire. */
  checkClock(): void {
    if (this.signal?.aborted) {
      throw new CodeLimitError('aborted', 'program cancelled');
    }
    if (Date.now() > this.limits.deadline) {
      throw new CodeLimitError('time', 'program exceeded its time budget');
    }
  }

  chargeToolCall(): void {
    if (this.toolCalls >= this.limits.maxToolCalls) {
      throw new CodeLimitError(
        'tool-calls',
        `program reached its limit of ${this.limits.maxToolCalls} tool calls`,
      );
    }
    this.toolCalls += 1;
  }

  enterCall(): void {
    this.depth += 1;
    if (this.depth > this.limits.maxDepth) {
      throw new CodeLimitError('depth', `call depth exceeded ${this.limits.maxDepth}`);
    }
  }

  exitCall(): void {
    this.depth -= 1;
  }

  /** Guards the few operations that can grow a value without bound. */
  checkString(length: number): void {
    if (length > this.limits.maxStringLength) {
      throw new CodeLimitError(
        'size',
        `string grew past ${this.limits.maxStringLength} characters`,
      );
    }
  }

  checkArray(length: number): void {
    if (length > this.limits.maxArrayLength) {
      throw new CodeLimitError('size', `array grew past ${this.limits.maxArrayLength} entries`);
    }
  }
}

/** Everything a builtin needs to reach back into the evaluator. */
export interface RunCtx {
  budget: Budget;
  log(text: string): void;
  callValue(fn: Value, args: Value[], node: Node): Promise<Value>;
  callTool(name: string, input: Value, node: Node): Promise<Value>;
}

// -------------------------------------------------------------- conversions

export function isCallable(v: Value): v is Callable {
  return v instanceof Closure || v instanceof NativeFn;
}

export function typeName(v: Value): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isCallable(v)) return 'function';
  if (v instanceof Namespace) return 'namespace';
  return typeof v;
}

/** Truthiness, matching JavaScript. */
export function truthy(v: Value): boolean {
  if (v === null || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return true;
}

/** Human-readable rendering, used by templates, `String()` and `log()`. */
export function display(v: Value, seen: Set<object> = new Set()): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof NativeFn) return `[builtin ${v.name}]`;
  if (v instanceof Closure) return '[function]';
  if (v instanceof Namespace) return `[namespace ${v.name}]`;
  if (seen.has(v)) return '[circular]';
  seen.add(v);
  try {
    if (Array.isArray(v)) return `[${v.map((x) => displayInner(x, seen)).join(', ')}]`;
    const entries = Object.keys(v).map((k) => `${k}: ${displayInner(v[k] ?? null, seen)}`);
    return `{ ${entries.join(', ')} }`;
  } finally {
    seen.delete(v);
  }
}

function displayInner(v: Value, seen: Set<object>): string {
  return typeof v === 'string' ? JSON.stringify(v) : display(v, seen);
}
