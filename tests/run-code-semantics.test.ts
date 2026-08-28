// RunCode — the places where the language quietly disagreed with JavaScript,
// and the places where a builtin escaped the budgets.
//
// The two groups are here for the same reason. A model writes JavaScript; it
// does not read this interpreter. Every divergence below was reproduced from a
// program a model would plausibly write, and each failed in the worst way
// available: a wrong answer reported as a success, or a whole process frozen
// past its own deadline. `run-code.test.ts` covers the language and the
// boundary; this file covers the disagreements.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb } from '../src/db/index.ts';
import { runCodeTool } from '../src/tools/code/tool.ts';
import { setPlanMode } from '../src/tools/planmode.ts';
import { setExtraTools } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { _resetWorkspaceForTesting } from '../src/tools/workspace.ts';

let home: string;
let work: string;
let prevHome: string | undefined;
let prevWorkspace: string | undefined;

async function run(program: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) {
  return runCodeTool.execute({ program, ...extra }, signal ? { signal } : {});
}

/** Runs a program that must succeed, and returns the rendered result. */
async function value(program: string): Promise<string> {
  const r = await run(program);
  expect(r.output).not.toContain('✗');
  expect(r.isError).toBe(false);
  return r.output;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-code-sem-home-'));
  work = await mkdtemp(join(tmpdir(), 'asterisk-code-sem-work-'));
  prevHome = process.env['ASTERISK_HOME'];
  prevWorkspace = process.env['ASTERISK_WORKSPACE'];
  process.env['ASTERISK_HOME'] = home;
  process.env['ASTERISK_WORKSPACE'] = work;
  _resetWorkspaceForTesting();
});

afterEach(async () => {
  setPlanMode(false);
  setExtraTools([]);
  closeDb();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  if (prevWorkspace === undefined) delete process.env['ASTERISK_WORKSPACE'];
  else process.env['ASTERISK_WORKSPACE'] = prevWorkspace;
  _resetWorkspaceForTesting();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

// An array big enough that sorting it is real work, small enough to stay under
// maxArrayLength. 'ab'.repeat(n).split('') is the shape the original report
// used; it is also the cheapest way to build a large array in one step.
const BIG_ARRAY = "const a = 'ab'.repeat(25000).split('');";

describe('RunCode budgets reach inside the builtins', () => {
  it('bounds split by maxArrayLength instead of building the array anyway', async () => {
    const r = await run("return 'ab'.repeat(600000).split('').length;");

    expect(r.isError).toBe(true);
    expect(r.output).toContain('array grew past');
  });

  it('bounds JSON.parse by maxArrayLength', async () => {
    // 200 KB of source is exactly maxToolOutputChars, so this is reachable from
    // a real tool result — no `repeat` needed to get there.
    const r = await run("return JSON.parse('[' + '1,'.repeat(199999) + '1]').length;");

    expect(r.isError).toBe(true);
    expect(r.output).toContain('array grew past');
  });

  it('charges steps for a sort with no comparator', async () => {
    // The comparator-less branch used to hand the array to the host sort, which
    // charges nothing: the step budget, the wall clock and the abort signal all
    // sat out the entire operation.
    const r = await run(`${BIG_ARRAY} for (let i = 0; i < 6; i++) { a.sort(); } return a.length;`, {
      timeoutSeconds: 300,
    });

    expect(r.isError).toBe(true);
    expect(r.output).toContain('evaluation steps');
  });

  it('lets a cancel signal interrupt a heavy sort, and keeps the event loop alive', async () => {
    // The ordering is the whole point. Under the old code the abort callback ran
    // *after* the program finished, because a synchronous host sort never handed
    // the event loop back — which is why neither ESC, nor the tool deadline, nor
    // the agent loop's Promise.race could touch it.
    // A single short timer is not enough: on a loaded machine the timers phase
    // can slip past the whole run, and the test then fails for a reason that
    // has nothing to do with the fix. An interval gets many chances to land
    // inside the run, and one landing is all the ordering claim needs.
    const order: string[] = [];
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (controller.signal.aborted) return;
      order.push('abort');
      controller.abort();
    }, 5);

    const r = await run(
      `${BIG_ARRAY} for (let i = 0; i < 6; i++) { a.sort(); } return a.length;`,
      { timeoutSeconds: 300 },
      controller.signal,
    );
    order.push('result');
    clearInterval(timer);

    expect(order).toEqual(['abort', 'result']);
    expect(r.isError).toBe(true);
    expect(r.output).toContain('cancelled');
  });

  it('sorts correctly with and without a comparator', async () => {
    const out = await value(`
      const words = ['pear', 'Apple', 'fig', 'apple'];
      const byLength = ['aaa', 'a', 'aa'].sort((x, y) => x.length - y.length);
      return [words.sort().join(','), byLength.join(','), [3, 20, 100].sort().join(',')].join('|');
    `);
    // Default sort compares rendered strings, as JavaScript's does.
    expect(out).toContain('return: Apple,apple,fig,pear|a,aa,aaa|100,20,3');
  });

  it('holds array growth by index to the same cap as push', async () => {
    // maxArrayLength is 100_000; the index path used to have its own 1_000_000.
    const r = await run('const a = []; a[500000] = 1; return a.length;');

    expect(r.isError).toBe(true);
    expect(r.output).toContain('array grew past');
  });
});

describe('RunCode rejects break and continue outside a loop', () => {
  it('refuses a top-level break instead of reporting success', async () => {
    const r = await run("log('did part 1'); break; log('part 2');");

    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
    expect(r.output).toContain('line 1');
    expect(r.output).toContain('loop');
  });

  it('refuses a top-level continue', async () => {
    const r = await run('continue;');

    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
  });

  it('refuses break inside an arrow function, as JavaScript does', async () => {
    const r = await run(
      'let n = 0; [1,2,3].forEach((x) => { n = n + 1; if (x === 1) break; }); return n;',
    );

    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
  });

  it('still allows break and continue inside every loop form', async () => {
    const out = await value(`
      let seen = '';
      for (const x of [1, 2, 3]) { if (x === 2) continue; seen = seen + x; }
      for (let i = 0; i < 9; i++) { if (i === 2) break; seen = seen + 'f'; }
      let n = 0;
      while (true) { n = n + 1; if (n > 1) break; }
      return seen + n;
    `);
    expect(out).toContain('return: 13ff2');
  });
});

describe('RunCode for-of respects let', () => {
  it('lets the loop variable be reassigned when declared with let', async () => {
    const out = await value(`
      const out = [];
      for (let s of ['  a  ', ' b ']) { s = s.trim(); out.push(s); }
      return out.join('|');
    `);
    expect(out).toContain('return: a|b');
  });

  it('still refuses to reassign a const loop variable', async () => {
    const r = await run("for (const s of ['a']) { s = 'b'; }");

    expect(r.isError).toBe(true);
    expect(r.output).toContain('const');
  });
});

describe('RunCode never throws out of runProgram', () => {
  it('reports an out-of-range \\u{…} escape as a syntax error', async () => {
    const r = await run('log("\\u{110000}");');

    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
    expect(r.output).toContain('line 1');
  });

  it('reports a negative \\u{…} escape as a syntax error', async () => {
    const r = await run('log("\\u{-1}");');

    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
  });

  it('still accepts a valid \\u{…} escape', async () => {
    const out = await value('return "\\u{1F600}".length;');
    expect(out).toContain('return: 2');
  });

  it('reports absurd nesting as a syntax error rather than a stack overflow', async () => {
    const r = await run(`return ${'('.repeat(5000)}1${')'.repeat(5000)};`);

    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
    expect(r.output).toContain('nest');
  });

  it('still parses ordinary nesting', async () => {
    const out = await value(`return ${'('.repeat(50)}1 + 1${')'.repeat(50)};`);
    expect(out).toContain('return: 2');
  });
});

describe('RunCode matches JavaScript semantics', () => {
  it('short-circuits a whole optional chain', async () => {
    const r = await run('const r = null; return r?.data.items;');
    expect(r.isError).toBe(false);
    expect(r.output).not.toContain('cannot read');

    const out = await value(`
      const r = null;
      const o = { deep: { list: [7] } };
      return [r?.data.items, r?.f(), r?.['k'], o?.deep.list[0]].join('/');
    `);
    expect(out).toContain('return: null/null/null/7');
  });

  it('reduces without an initial value by starting from the first element', async () => {
    const out = await value(`
      const sum = [1, 2, 3].reduce((a, b) => a + b);
      const withInit = [1, 2, 3].reduce((a, b) => a + b, 10);
      return sum + '/' + withInit;
    `);
    expect(out).toContain('return: 6/16');
  });

  it('refuses to reduce an empty array with no initial value', async () => {
    const r = await run('return [].reduce((a, b) => a + b);');
    expect(r.isError).toBe(true);
    expect(r.output).toContain('empty array');
  });

  it('gives a C-style for loop one binding per iteration', async () => {
    const out = await value(`
      const fns = [];
      for (let i = 0; i < 3; i++) { fns.push(() => i); }
      return fns.map((f) => f()).join(',');
    `);
    expect(out).toContain('return: 0,1,2');
  });

  it('evaluates an assignment target once', async () => {
    setExtraTools([countingTool()]);

    // The target of a compound assignment can be a tool call. Evaluating it
    // twice runs the command twice and spends two calls from the budget.
    const r = await run("tool('TestCount', {}).output += 'x'; return 'done';");

    expect(r.isError).toBe(false);
    expect(r.output).toContain('1 tool call');
  });

  it('evaluates an update target once', async () => {
    const out = await value(`
      const boxes = [{ n: 0 }];
      let picks = 0;
      const pick = () => { picks = picks + 1; return 0; };
      boxes[pick()].n += 1;
      boxes[pick()].n++;
      return picks + '/' + boxes[0].n;
    `);
    expect(out).toContain('return: 2/2');
  });

  it('short-circuits some and every', async () => {
    const out = await value(`
      let seen = 0;
      const hit = [1, 2, 3, 4].some((x) => { seen = seen + 1; return x === 1; });
      let checked = 0;
      const all = [1, 2, 3, 4].every((x) => { checked = checked + 1; return x === 0; });
      return [hit, seen, all, checked].join('/');
    `);
    expect(out).toContain('return: true/1/false/1');
  });

  it('still walks the whole array when some and every need to', async () => {
    const out = await value(`
      let seen = 0;
      const hit = [1, 2, 3].some((x) => { seen = seen + 1; return x === 9; });
      return hit + '/' + seen;
    `);
    expect(out).toContain('return: false/3');
  });

  it('normalises array index writes the way reads do', async () => {
    const r = await run('const a = [1, 2]; a[""] = 9; return a.join(",");');
    expect(r.isError).toBe(true);
    expect(r.output).toContain('integer index');

    const spaced = await run('const a = [1, 2]; a[" 1 "] = 9; return a.join(",");');
    expect(spaced.isError).toBe(true);
    expect(spaced.output).toContain('integer index');

    // And the matching read is still the quiet null it always was.
    const out = await value('const a = [1, 2]; return String(a[""]) + "/" + a[1];');
    expect(out).toContain('return: null/2');
  });

  it('reads binary and octal literals', async () => {
    const out = await value('return [0b1010, 0o777, 0xff, 0b1010 + 1].join("/");');
    expect(out).toContain('return: 10/511/255/11');
  });

  it('refuses a malformed binary literal instead of answering 0', async () => {
    const r = await run('return 0b12;');
    expect(r.isError).toBe(true);
    expect(r.output).toContain('will not parse');
  });
});

// ------------------------------------------------------------------ helpers

function countingTool(): Tool {
  let n = 0;
  return {
    name: 'TestCount',
    description: 'counts calls',
    input_schema: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => {
      n += 1;
      return { output: String(n), isError: false };
    },
  };
}
