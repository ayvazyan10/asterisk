// Dotted-path access for plain objects.
//
// The settings table stores one row per leaf of the config tree, keyed by a
// path like `bots.telegram.streamMode`. These helpers convert between that
// flat representation and the nested object the Zod schema expects. Both
// directions are non-mutating.

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads `path` out of `obj`, or undefined if any segment is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Returns a copy of `obj` with `path` set to `value`. Intermediate objects are
 * created as needed and copied rather than mutated, so the input is untouched.
 */
export function setPath<T extends Plain>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return obj;

  if (rest.length === 0) {
    return { ...obj, [head]: value };
  }

  const child = obj[head];
  const base: Plain = isPlainObject(child) ? child : {};
  return { ...obj, [head]: setPath(base, rest.join('.'), value) };
}

/**
 * Flattens a nested object into dotted-path entries. Arrays and null are
 * treated as leaf values — the config tree has no arrays-of-objects outside
 * the collections that live in their own tables.
 */
export function flatten(obj: Plain, prefix = ''): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      out.push(...flatten(value, path));
    } else {
      out.push([path, value]);
    }
  }
  return out;
}

/** Rebuilds a nested object from dotted-path entries. */
export function unflatten(entries: Iterable<[string, unknown]>): Plain {
  let out: Plain = {};
  for (const [path, value] of entries) {
    out = setPath(out, path, value);
  }
  return out;
}
