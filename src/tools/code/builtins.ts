// Builtins and member access for the RunCode mini-language.
//
// This module is the whitelist. Member access on a string, an array or a number
// never touches the host prototype chain — it looks the name up in a table here
// and returns a fresh `NativeFn`. That is what keeps `"".constructor` (host
// `String`), `[].constructor` (host `Array`) and from there
// `Function('return process')()` out of the program's reach. Anything not in a
// table below simply does not exist.

import type { Node } from './ast.ts';
import {
  Closure,
  CodeRuntimeError,
  Namespace,
  NativeFn,
  type RunCtx,
  type Value,
  type ValueObject,
  display,
  isCallable,
  truthy,
  typeName,
} from './values.ts';

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(message: string, node: Node): never {
  throw new CodeRuntimeError(message, node);
}

function arg(args: Value[], i: number): Value {
  return args[i] ?? null;
}

function asString(v: Value, node: Node, what: string): string {
  if (typeof v !== 'string') fail(`${what} expects a string, got ${typeName(v)}`, node);
  return v;
}

function asNumber(v: Value, node: Node, what: string): number {
  if (typeof v !== 'number') fail(`${what} expects a number, got ${typeName(v)}`, node);
  return v;
}

function optNumber(v: Value, fallback: number, node: Node, what: string): number {
  if (v === null) return fallback;
  return asNumber(v, node, what);
}

function asArray(v: Value, node: Node, what: string): Value[] {
  if (!Array.isArray(v)) fail(`${what} expects an array, got ${typeName(v)}`, node);
  return v;
}

/** Creates the plain, prototype-less object the language uses for `{}`. */
export function makeObject(): ValueObject {
  return Object.create(null) as ValueObject;
}

// ------------------------------------------------------------ string members

function stringMember(recv: string, key: string, node: Node): Value | undefined {
  if (key === 'length') return recv.length;

  switch (key) {
    case 'split':
      return new NativeFn('split', (a, _c, n) => recv.split(asString(arg(a, 0), n, 'split')));
    case 'slice':
      return new NativeFn('slice', (a, _c, n) =>
        recv.slice(
          optNumber(arg(a, 0), 0, n, 'slice'),
          arg(a, 1) === null ? undefined : asNumber(arg(a, 1), n, 'slice'),
        ),
      );
    case 'substring':
      return new NativeFn('substring', (a, _c, n) =>
        recv.substring(
          optNumber(arg(a, 0), 0, n, 'substring'),
          arg(a, 1) === null ? undefined : asNumber(arg(a, 1), n, 'substring'),
        ),
      );
    case 'indexOf':
      return new NativeFn('indexOf', (a, _c, n) => recv.indexOf(asString(arg(a, 0), n, 'indexOf')));
    case 'lastIndexOf':
      return new NativeFn('lastIndexOf', (a, _c, n) =>
        recv.lastIndexOf(asString(arg(a, 0), n, 'lastIndexOf')),
      );
    case 'includes':
      return new NativeFn('includes', (a, _c, n) =>
        recv.includes(asString(arg(a, 0), n, 'includes')),
      );
    case 'startsWith':
      return new NativeFn('startsWith', (a, _c, n) =>
        recv.startsWith(asString(arg(a, 0), n, 'startsWith')),
      );
    case 'endsWith':
      return new NativeFn('endsWith', (a, _c, n) =>
        recv.endsWith(asString(arg(a, 0), n, 'endsWith')),
      );
    case 'toUpperCase':
      return new NativeFn('toUpperCase', () => recv.toUpperCase());
    case 'toLowerCase':
      return new NativeFn('toLowerCase', () => recv.toLowerCase());
    case 'trim':
      return new NativeFn('trim', () => recv.trim());
    case 'trimStart':
      return new NativeFn('trimStart', () => recv.trimStart());
    case 'trimEnd':
      return new NativeFn('trimEnd', () => recv.trimEnd());
    case 'charAt':
      return new NativeFn('charAt', (a, _c, n) =>
        recv.charAt(optNumber(arg(a, 0), 0, n, 'charAt')),
      );
    case 'at':
      return new NativeFn('at', (a, _c, n) => recv.at(optNumber(arg(a, 0), 0, n, 'at')) ?? null);
    case 'concat':
      return new NativeFn('concat', (a, c, n) => {
        const other = asString(arg(a, 0), n, 'concat');
        c.budget.checkString(recv.length + other.length);
        return recv + other;
      });
    case 'repeat':
      return new NativeFn('repeat', (a, c, n) => {
        const count = Math.max(0, Math.floor(asNumber(arg(a, 0), n, 'repeat')));
        c.budget.checkString(recv.length * count);
        return recv.repeat(count);
      });
    case 'padStart':
      return new NativeFn('padStart', (a, c, n) => {
        const width = asNumber(arg(a, 0), n, 'padStart');
        c.budget.checkString(width);
        return recv.padStart(width, arg(a, 1) === null ? ' ' : asString(arg(a, 1), n, 'padStart'));
      });
    case 'padEnd':
      return new NativeFn('padEnd', (a, c, n) => {
        const width = asNumber(arg(a, 0), n, 'padEnd');
        c.budget.checkString(width);
        return recv.padEnd(width, arg(a, 1) === null ? ' ' : asString(arg(a, 1), n, 'padEnd'));
      });
    // `replace`/`replaceAll` take plain strings only. There are no regular
    // expressions in this language, so there is no catastrophic-backtracking
    // denial of service to bound either.
    case 'replace':
      return new NativeFn('replace', (a, c, n) => {
        const out = recv.replace(
          asString(arg(a, 0), n, 'replace'),
          asString(arg(a, 1), n, 'replace'),
        );
        c.budget.checkString(out.length);
        return out;
      });
    case 'replaceAll':
      return new NativeFn('replaceAll', (a, c, n) => {
        const out = recv
          .split(asString(arg(a, 0), n, 'replaceAll'))
          .join(asString(arg(a, 1), n, 'replaceAll'));
        c.budget.checkString(out.length);
        return out;
      });
    default:
      return undefined;
  }
}

// ------------------------------------------------------------- array members

async function mapLike(
  recv: Value[],
  fn: Value,
  ctx: RunCtx,
  node: Node,
  what: string,
): Promise<Value[]> {
  if (!isCallable(fn)) fail(`${what} expects a function, got ${typeName(fn)}`, node);
  const out: Value[] = [];
  for (let i = 0; i < recv.length; i += 1) {
    ctx.budget.tick();
    out.push(await ctx.callValue(fn, [recv[i] ?? null, i], node));
  }
  return out;
}

function arrayMember(recv: Value[], key: string, node: Node): Value | undefined {
  if (key === 'length') return recv.length;

  switch (key) {
    case 'push':
      return new NativeFn('push', (a, c) => {
        c.budget.checkArray(recv.length + a.length);
        for (const v of a) recv.push(v);
        return recv.length;
      });
    case 'pop':
      return new NativeFn('pop', () => recv.pop() ?? null);
    case 'shift':
      return new NativeFn('shift', () => recv.shift() ?? null);
    case 'unshift':
      return new NativeFn('unshift', (a, c) => {
        c.budget.checkArray(recv.length + a.length);
        return recv.unshift(...a);
      });
    case 'slice':
      return new NativeFn('slice', (a, _c, n) =>
        recv.slice(
          optNumber(arg(a, 0), 0, n, 'slice'),
          arg(a, 1) === null ? undefined : asNumber(arg(a, 1), n, 'slice'),
        ),
      );
    case 'join':
      return new NativeFn('join', (a, c, n) => {
        const sep = arg(a, 0) === null ? ',' : asString(arg(a, 0), n, 'join');
        const out = recv.map((v) => display(v)).join(sep);
        c.budget.checkString(out.length);
        return out;
      });
    case 'indexOf':
      return new NativeFn('indexOf', (a) => recv.indexOf(arg(a, 0)));
    case 'includes':
      return new NativeFn('includes', (a) => recv.includes(arg(a, 0)));
    case 'reverse':
      return new NativeFn('reverse', () => recv.reverse());
    case 'concat':
      return new NativeFn('concat', (a, c, n) => {
        const other = asArray(arg(a, 0), n, 'concat');
        c.budget.checkArray(recv.length + other.length);
        return [...recv, ...other];
      });
    case 'map':
      return new NativeFn('map', async (a, c, n) => mapLike(recv, arg(a, 0), c, n, 'map'));
    case 'forEach':
      return new NativeFn('forEach', async (a, c, n) => {
        await mapLike(recv, arg(a, 0), c, n, 'forEach');
        return null;
      });
    case 'filter':
      return new NativeFn('filter', async (a, c, n) => {
        const flags = await mapLike(recv, arg(a, 0), c, n, 'filter');
        return recv.filter((_v, i) => truthy(flags[i] ?? null));
      });
    case 'find':
      return new NativeFn('find', async (a, c, n) => {
        const fn = arg(a, 0);
        if (!isCallable(fn)) fail(`find expects a function, got ${typeName(fn)}`, n);
        for (let i = 0; i < recv.length; i += 1) {
          c.budget.tick();
          if (truthy(await c.callValue(fn, [recv[i] ?? null, i], n))) return recv[i] ?? null;
        }
        return null;
      });
    case 'findIndex':
      return new NativeFn('findIndex', async (a, c, n) => {
        const fn = arg(a, 0);
        if (!isCallable(fn)) fail(`findIndex expects a function, got ${typeName(fn)}`, n);
        for (let i = 0; i < recv.length; i += 1) {
          c.budget.tick();
          if (truthy(await c.callValue(fn, [recv[i] ?? null, i], n))) return i;
        }
        return -1;
      });
    case 'some':
      return new NativeFn('some', async (a, c, n) => {
        const flags = await mapLike(recv, arg(a, 0), c, n, 'some');
        return flags.some((f) => truthy(f));
      });
    case 'every':
      return new NativeFn('every', async (a, c, n) => {
        const flags = await mapLike(recv, arg(a, 0), c, n, 'every');
        return flags.every((f) => truthy(f));
      });
    case 'reduce':
      return new NativeFn('reduce', async (a, c, n) => {
        const fn = arg(a, 0);
        if (!isCallable(fn)) fail(`reduce expects a function, got ${typeName(fn)}`, n);
        let acc = arg(a, 1);
        for (let i = 0; i < recv.length; i += 1) {
          c.budget.tick();
          acc = await c.callValue(fn, [acc, recv[i] ?? null, i], n);
        }
        return acc;
      });
    case 'sort':
      return new NativeFn('sort', async (a, c, n) => {
        const fn = arg(a, 0);
        if (fn === null) {
          return recv.sort((x, y) =>
            display(x) < display(y) ? -1 : display(x) > display(y) ? 1 : 0,
          );
        }
        if (!isCallable(fn)) fail(`sort expects a function, got ${typeName(fn)}`, n);
        // Insertion sort so the comparator can be awaited; arrays here are
        // bounded by maxArrayLength and the step budget charges every compare.
        for (let i = 1; i < recv.length; i += 1) {
          const current = recv[i] ?? null;
          let j = i - 1;
          while (j >= 0) {
            c.budget.tick();
            const order = await c.callValue(fn, [recv[j] ?? null, current], n);
            if (typeof order !== 'number' || order <= 0) break;
            recv[j + 1] = recv[j] ?? null;
            j -= 1;
          }
          recv[j + 1] = current;
        }
        return recv;
      });
    default:
      return undefined;
  }
}

// ------------------------------------------------------------ number members

function numberMember(recv: number, key: string): Value | undefined {
  switch (key) {
    case 'toFixed':
      return new NativeFn('toFixed', (a, _c, n) =>
        recv.toFixed(Math.min(20, Math.max(0, optNumber(arg(a, 0), 0, n, 'toFixed')))),
      );
    case 'toString':
      return new NativeFn('toString', () => String(recv));
    default:
      return undefined;
  }
}

/** The non-negative integer `key` denotes, or null when it is a name. */
function arrayIndex(key: string): number | null {
  if (key === '' || !/^\d+$/.test(key)) return null;
  const n = Number(key);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Property read. The only path from a value to anything callable, and it never
 * consults a host prototype.
 */
export function getMember(object: Value, key: string, node: Node): Value {
  if (object === null) {
    fail(`cannot read "${key}" of null`, node);
  }
  if (BLOCKED_KEYS.has(key)) {
    fail(`"${key}" is not readable`, node);
  }

  // Indexing comes first, because `key` arrives as a string even when it was
  // written as a number: `parts[0]` reaches here as "0", and falling through to
  // the method tables would silently answer null. It did, and the first
  // realistic program written against this — split a Grep line on ":" and take
  // field 0 — got null for every path and edited nothing.
  const index = arrayIndex(key);
  if (typeof object === 'string') {
    if (index !== null) return object[index] ?? null;
    return stringMember(object, key, node) ?? null;
  }
  if (Array.isArray(object)) {
    if (index !== null) return object[index] ?? null;
    return arrayMember(object, key, node) ?? null;
  }
  if (typeof object === 'number') return numberMember(object, key) ?? null;
  if (typeof object === 'boolean') return null;

  if (object instanceof Namespace) return object.members.get(key) ?? null;
  if (object instanceof NativeFn || object instanceof Closure) {
    fail('functions have no properties', node);
  }

  // A plain object built by the program. Own properties only — the literal is
  // prototype-less, and this check keeps a JSON.parse result honest too.
  return Object.prototype.hasOwnProperty.call(object, key) ? (object[key] ?? null) : null;
}

/** Property write. Mirrors getMember's refusals. */
export function setMember(object: Value, key: string, value: Value, node: Node): void {
  if (object === null) fail(`cannot set "${key}" of null`, node);
  if (BLOCKED_KEYS.has(key)) fail(`"${key}" is not writable`, node);

  if (Array.isArray(object)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      fail(`cannot set "${key}" on an array — use an integer index`, node);
    }
    if (index >= object.length) {
      // Assigning past the end is how a program grows an array without push;
      // charge it against the same cap.
      throwIfHuge(index + 1, node);
    }
    object[index] = value;
    return;
  }

  if (typeof object === 'object' && !(object instanceof Namespace) && !isCallable(object)) {
    object[key] = value;
    return;
  }

  fail(`cannot set properties on ${typeName(object)}`, node);
}

const HARD_ARRAY_CAP = 1_000_000;

function throwIfHuge(length: number, node: Node): void {
  if (length > HARD_ARRAY_CAP) fail(`array index ${length - 1} is too large`, node);
}

// ----------------------------------------------------------------- globals

function jsonToValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(jsonToValue);
  const out = makeObject();
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (BLOCKED_KEYS.has(k)) continue;
    out[k] = jsonToValue(raw);
  }
  return out;
}

/** Drops closures and namespaces rather than serialising their innards — a
 *  `JSON.stringify(fn)` that leaked a Closure's captured Env into the program's
 *  own output would put the interpreter's internals on the wire. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Closure || value instanceof NativeFn || value instanceof Namespace) {
    return undefined;
  }
  return value;
}

function namespace(name: string, entries: Array<[string, Value]>): Namespace {
  return new Namespace(name, new Map(entries));
}

const JSON_NS = namespace('JSON', [
  [
    'parse',
    new NativeFn('JSON.parse', (a, _c, n) => {
      const text = asString(arg(a, 0), n, 'JSON.parse');
      try {
        return jsonToValue(JSON.parse(text) as unknown);
      } catch (e) {
        fail(`JSON.parse failed: ${(e as Error).message}`, n);
      }
    }),
  ],
  [
    'stringify',
    new NativeFn('JSON.stringify', (a, c, n) => {
      const indent = arg(a, 1) === null ? undefined : asNumber(arg(a, 1), n, 'JSON.stringify');
      const out = JSON.stringify(arg(a, 0), jsonReplacer, indent);
      if (out === undefined) return null;
      c.budget.checkString(out.length);
      return out;
    }),
  ],
]);

const OBJECT_NS = namespace('Object', [
  [
    'keys',
    new NativeFn('Object.keys', (a, _c, n) => {
      const o = arg(a, 0);
      if (Array.isArray(o)) return o.map((_v, i) => String(i));
      if (o === null || typeof o !== 'object' || o instanceof Namespace || isCallable(o)) {
        fail(`Object.keys expects an object, got ${typeName(o)}`, n);
      }
      return Object.keys(o);
    }),
  ],
  [
    'values',
    new NativeFn('Object.values', (a, _c, n) => {
      const o = arg(a, 0);
      if (Array.isArray(o)) return [...o];
      if (o === null || typeof o !== 'object' || o instanceof Namespace || isCallable(o)) {
        fail(`Object.values expects an object, got ${typeName(o)}`, n);
      }
      return Object.keys(o).map((k) => o[k] ?? null);
    }),
  ],
  [
    'entries',
    new NativeFn('Object.entries', (a, _c, n) => {
      const o = arg(a, 0);
      if (o === null || typeof o !== 'object' || Array.isArray(o) || o instanceof Namespace) {
        fail(`Object.entries expects an object, got ${typeName(o)}`, n);
      }
      if (isCallable(o)) fail('Object.entries expects an object, got function', n);
      return Object.keys(o).map((k) => [k, o[k] ?? null] as Value);
    }),
  ],
]);

function mathFn(name: string, f: (x: number) => number): [string, Value] {
  return [name, new NativeFn(`Math.${name}`, (a, _c, n) => f(asNumber(arg(a, 0), n, name)))];
}

const MATH_NS = namespace('Math', [
  mathFn('floor', Math.floor),
  mathFn('ceil', Math.ceil),
  mathFn('round', Math.round),
  mathFn('abs', Math.abs),
  mathFn('sqrt', Math.sqrt),
  mathFn('trunc', Math.trunc),
  ['min', new NativeFn('Math.min', (a, _c, n) => Math.min(...a.map((v) => asNumber(v, n, 'min'))))],
  ['max', new NativeFn('Math.max', (a, _c, n) => Math.max(...a.map((v) => asNumber(v, n, 'max'))))],
  // Deliberately no Math.random: a program that behaves differently on each run
  // is one that cannot be re-run to reproduce what it did to the working tree.
]);

const ARRAY_NS = namespace('Array', [
  ['isArray', new NativeFn('Array.isArray', (a) => Array.isArray(arg(a, 0)))],
]);

/** The global scope a program starts with. `tool` and `log` are installed by
 *  the interpreter, which owns the bridge and the log buffer. */
export function globalBindings(): Array<[string, Value]> {
  return [
    ['JSON', JSON_NS],
    ['Object', OBJECT_NS],
    ['Math', MATH_NS],
    ['Array', ARRAY_NS],
    ['String', new NativeFn('String', (a) => display(arg(a, 0)))],
    [
      'Number',
      new NativeFn('Number', (a) => {
        const v = arg(a, 0);
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          const n = Number(v.trim());
          return Number.isNaN(n) ? null : n;
        }
        if (typeof v === 'boolean') return v ? 1 : 0;
        return null;
      }),
    ],
    ['Boolean', new NativeFn('Boolean', (a) => truthy(arg(a, 0)))],
  ];
}
