// Shared test helpers. Not a test file — vitest only collects *.test.ts.

/**
 * Narrows away null/undefined, throwing with a useful message instead.
 *
 * Tests reach for `value!` constantly: indexing an array they just filled,
 * reading a capture they know fired. The assertion silences the type error and
 * nothing else — when the assumption is wrong the test dies on
 * "Cannot read properties of undefined" several lines later, pointing at the
 * symptom rather than the cause. This says which value was missing.
 */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be defined, got ${String(value)}`);
  }
  return value;
}
