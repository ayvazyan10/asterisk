// Sorting for the RunCode mini-language.
//
// `Array.prototype.sort` is not reachable from a program and must not become
// reachable through a builtin either. The host sort runs to completion in one
// synchronous burst: it charges no step, never consults the clock or the abort
// signal, and never hands the event loop back. One `.sort()` over a large
// array therefore outlived the tool's own deadline by a factor of five, and
// the cancel callback scheduled for 50ms into the run only fired *after* the
// program had finished — because ESC, the tool timeout and the agent loop's
// Promise.race are all timers, and no timer runs while the loop is blocked.
//
// So sorting is done here instead: a bottom-up merge sort that charges the
// budget per comparison and yields on the same cadence the interpreter's loops
// use. Merge sort rather than the insertion sort this replaced because the
// comparator may be a program's arrow function — O(n²) awaited calls over an
// array of any size is its own denial of service — and because merge sort is
// stable, which is what JavaScript's sort promises.

import { type Budget, type Value, display, yieldIfDue } from './values.ts';

/** Negative, zero or positive, like a JavaScript comparator. May be async,
 *  because a program's comparator is an arrow function the evaluator awaits. */
export type SortComparator = (a: Value, b: Value) => number | Promise<number>;

/** Sorts `items` in place and returns it, charging one step per comparison. */
export async function budgetedSort(
  items: Value[],
  cmp: SortComparator,
  budget: Budget,
): Promise<Value[]> {
  const n = items.length;
  if (n < 2) return items;

  let src = items.slice();
  let dst: Value[] = new Array<Value>(n).fill(null);
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += width * 2) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + width * 2, n);
      await merge(src, dst, lo, mid, hi, cmp, budget);
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  for (let i = 0; i < n; i += 1) items[i] = src[i] ?? null;
  return items;
}

/** Merges the two sorted runs `[lo, mid)` and `[mid, hi)` of `src` into `dst`. */
async function merge(
  src: Value[],
  dst: Value[],
  lo: number,
  mid: number,
  hi: number,
  cmp: SortComparator,
  budget: Budget,
): Promise<void> {
  let i = lo;
  let j = mid;
  for (let k = lo; k < hi; k += 1) {
    budget.tick();
    const pause = yieldIfDue(budget);
    if (pause) await pause;
    const takeLeft =
      i < mid && (j >= hi || (await order(cmp, src[i] ?? null, src[j] ?? null)) <= 0);
    if (takeLeft) {
      dst[k] = src[i] ?? null;
      i += 1;
    } else {
      dst[k] = src[j] ?? null;
      j += 1;
    }
  }
}

/** A comparator that answers with anything but a number leaves the order
 *  alone, which is what the previous insertion sort did with such a result. */
async function order(cmp: SortComparator, a: Value, b: Value): Promise<number> {
  const raw = cmp(a, b);
  const value = typeof raw === 'number' ? raw : await raw;
  return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
}

/**
 * The comparator-less `sort()`: JavaScript compares elements as strings, and
 * so does this. The rendering is computed once per element rather than once
 * per comparison — the old branch called `display` four times per compare,
 * which is n log n renderings of every element in the array.
 */
export async function sortByDisplay(items: Value[], budget: Budget): Promise<Value[]> {
  const keys: string[] = [];
  for (const item of items) {
    budget.tick();
    keys.push(display(item));
  }

  const positions: Value[] = keys.map((_k, i) => i);
  await budgetedSort(
    positions,
    (a, b) => {
      const ka = keys[a as number] ?? '';
      const kb = keys[b as number] ?? '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    },
    budget,
  );

  const sorted = positions.map((p) => items[p as number] ?? null);
  for (let i = 0; i < items.length; i += 1) items[i] = sorted[i] ?? null;
  return items;
}
