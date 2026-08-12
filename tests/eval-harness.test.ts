// Unit coverage for the eval harness itself.
//
// The harness grades other code, so a bug here is worse than a bug in the thing
// it grades: a criterion that always passes turns the whole suite into a green
// light that means nothing. Every criterion is therefore tested on both sides —
// the case it should accept and the case it must reject.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs, runEvalCli } from '../src/eval/cli.ts';
import {
  custom,
  fileAbsent,
  fileContains,
  fileLacks,
  fileMatches,
  finalTextMatches,
  modelGraded,
  terminalReason,
  toolCalled,
  toolErrored,
  toolNotCalled,
  toolSequence,
  toolSucceeded,
} from '../src/eval/criteria.ts';
import { createCallRecorder } from '../src/eval/recorder.ts';
import { formatSuite, suiteToJson } from '../src/eval/report.ts';
import { runScenario, runSuite, selectScenarios } from '../src/eval/runner.ts';
import { lastCallFailed, say, toolBatch, toolUse } from '../src/eval/script-helpers.ts';
import { createScriptedProvider } from '../src/eval/script-provider.ts';
import type { Criterion, Scenario, ToolCall, Transcript } from '../src/eval/types.ts';
import { createFixture, renderPrompt, withEvalWorkspace } from '../src/eval/workspace.ts';
import { _resetWorkspaceForTesting, workspaceRoot } from '../src/tools/workspace.ts';
import type { Provider } from '../src/types/messages.ts';
import { defined } from './helpers.ts';

let workspace: string;
let prevWorkspaceEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'asterisk-evaltest-'));
  prevWorkspaceEnv = process.env['ASTERISK_WORKSPACE'];
});

afterEach(async () => {
  if (prevWorkspaceEnv === undefined) delete process.env['ASTERISK_WORKSPACE'];
  else process.env['ASTERISK_WORKSPACE'] = prevWorkspaceEnv;
  _resetWorkspaceForTesting();
  await rm(workspace, { recursive: true, force: true });
});

function call(over: Partial<ToolCall> = {}): ToolCall {
  return { name: 'Edit', input: {}, output: 'ok', isError: false, settled: true, ...over };
}

function transcript(over: Partial<Transcript> = {}): Transcript {
  return { workspace, calls: [], finalText: '', reason: 'end-turn', ...over };
}

async function grade(criterion: Criterion, t: Transcript, grader?: Provider) {
  return await criterion.check(t, grader ? { grader } : {});
}

describe('file criteria', () => {
  it('fileContains passes on a hit and fails on a miss', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world', 'utf8');
    expect((await grade(fileContains('a.txt', 'hello'), transcript())).passed).toBe(true);
    expect((await grade(fileContains('a.txt', 'goodbye'), transcript())).passed).toBe(false);
  });

  it('fileContains fails — not passes — when the file is missing entirely', async () => {
    const outcome = await grade(fileContains('nope.txt', 'anything'), transcript());
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toMatch(/does not exist/);
  });

  it('fileLacks fails when the string survived, and when the file vanished', async () => {
    await writeFile(join(workspace, 'a.txt'), 'old value', 'utf8');
    expect((await grade(fileLacks('a.txt', 'old'), transcript())).passed).toBe(false);
    expect((await grade(fileLacks('a.txt', 'new'), transcript())).passed).toBe(true);
    // A deleted file is not proof the string was removed properly.
    expect((await grade(fileLacks('gone.txt', 'old'), transcript())).passed).toBe(false);
  });

  it('fileMatches applies the regex to the file body', async () => {
    await writeFile(join(workspace, 'c.ini'), 'timeout = 60\n', 'utf8');
    expect((await grade(fileMatches('c.ini', /timeout\s*=\s*60/), transcript())).passed).toBe(true);
    expect((await grade(fileMatches('c.ini', /timeout\s*=\s*30/), transcript())).passed).toBe(
      false,
    );
  });

  it('fileAbsent is the refusal shape — passes only when nothing was written', async () => {
    expect((await grade(fileAbsent('ghost.txt'), transcript())).passed).toBe(true);
    await writeFile(join(workspace, 'ghost.txt'), 'oops', 'utf8');
    expect((await grade(fileAbsent('ghost.txt'), transcript())).passed).toBe(false);
  });
});

describe('tool transcript criteria', () => {
  const calls = [
    call({ name: 'Read' }),
    call({ name: 'Edit', isError: true, output: 'oldString not found in file' }),
    call({ name: 'Edit' }),
  ];

  it('toolCalled honours exact and minimum counts', async () => {
    const t = transcript({ calls });
    expect((await grade(toolCalled('Edit', { times: 2 }), t)).passed).toBe(true);
    expect((await grade(toolCalled('Edit', { times: 1 }), t)).passed).toBe(false);
    expect((await grade(toolCalled('Read', { atLeast: 1 }), t)).passed).toBe(true);
    expect((await grade(toolCalled('Grep', { atLeast: 1 }), t)).passed).toBe(false);
  });

  it('toolCalled can narrow by input', async () => {
    const t = transcript({ calls: [call({ name: 'Edit', input: { path: '/x/a.ts' } })] });
    const matching = toolCalled('Edit', { withInput: (i) => i['path'] === '/x/a.ts' });
    const other = toolCalled('Edit', { withInput: (i) => i['path'] === '/x/b.ts' });
    expect((await grade(matching, t)).passed).toBe(true);
    expect((await grade(other, t)).passed).toBe(false);
  });

  it('toolNotCalled is the negative form', async () => {
    const t = transcript({ calls });
    expect((await grade(toolNotCalled('Bash'), t)).passed).toBe(true);
    expect((await grade(toolNotCalled('Edit'), t)).passed).toBe(false);
  });

  it('toolSequence matches a subsequence, not a prefix', async () => {
    const t = transcript({ calls });
    expect((await grade(toolSequence(['Read', 'Edit', 'Edit']), t)).passed).toBe(true);
    // Unrelated calls in between are tolerated…
    expect((await grade(toolSequence(['Read', 'Edit']), t)).passed).toBe(true);
    // …but the order is not: Read comes first in the transcript, so asking for
    // Edit-then-Read must fail even though both tools were used.
    expect((await grade(toolSequence(['Edit', 'Read']), t)).passed).toBe(false);
    expect((await grade(toolSequence(['Grep', 'Read']), t)).passed).toBe(false);
    expect((await grade(toolSequence(['Read', 'Edit', 'Edit', 'Edit']), t)).passed).toBe(false);
  });

  it('toolErrored needs a real failure, and can require a pattern', async () => {
    const t = transcript({ calls });
    expect((await grade(toolErrored('Edit'), t)).passed).toBe(true);
    expect((await grade(toolErrored('Edit', /not found/), t)).passed).toBe(true);
    expect((await grade(toolErrored('Edit', /permission denied/), t)).passed).toBe(false);
    expect((await grade(toolErrored('Read'), t)).passed).toBe(false);
  });

  it('toolSucceeded fails on a mixed run and on a tool never called', async () => {
    expect((await grade(toolSucceeded('Edit'), transcript({ calls }))).passed).toBe(false);
    expect((await grade(toolSucceeded('Read'), transcript({ calls }))).passed).toBe(true);
    expect((await grade(toolSucceeded('Glob'), transcript({ calls }))).passed).toBe(false);
  });
});

describe('turn-outcome criteria', () => {
  it('finalTextMatches and terminalReason both discriminate', async () => {
    const t = transcript({ finalText: 'Fixed the operator.', reason: 'end-turn' });
    expect((await grade(finalTextMatches(/fixed/i), t)).passed).toBe(true);
    expect((await grade(finalTextMatches(/deleted/i), t)).passed).toBe(false);
    expect((await grade(terminalReason('end-turn'), t)).passed).toBe(true);
    expect((await grade(terminalReason('max-turns'), t)).passed).toBe(false);
  });

  it('custom treats a returned string as a failure reason', async () => {
    expect(
      (
        await grade(
          custom('ok', () => true),
          transcript(),
        )
      ).passed,
    ).toBe(true);
    const failed = await grade(
      custom('nope', () => 'because reasons'),
      transcript(),
    );
    expect(failed.passed).toBe(false);
    expect(failed.detail).toBe('because reasons');
  });
});

describe('modelGraded is quarantined', () => {
  it('skips without a grader rather than passing', async () => {
    const outcome = await grade(modelGraded('did it work?'), transcript());
    expect(outcome.skipped).toBe(true);
    expect(outcome.passed).toBe(false);
  });

  it('skips — not fails — when the grader throws, so a network blip is not a defect', async () => {
    const broken: Provider = {
      name: 'broken',
      send: () => Promise.reject(new Error('connection refused')),
    };
    const outcome = await grade(modelGraded('did it work?'), transcript(), broken);
    expect(outcome.skipped).toBe(true);
    expect(outcome.detail).toMatch(/connection refused/);
  });

  it('reads a PASS/FAIL verdict off the grader', async () => {
    const verdictProvider = (text: string): Provider => ({
      name: 'grader',
      send: async () => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' }),
    });
    const yes = await grade(modelGraded('q'), transcript(), verdictProvider('PASS looks right'));
    const no = await grade(modelGraded('q'), transcript(), verdictProvider('FAIL nope'));
    expect(yes.passed).toBe(true);
    expect(yes.skipped).toBeUndefined();
    expect(no.passed).toBe(false);
  });

  it('is labelled so a report can never present it as objective', () => {
    const criterion = modelGraded('did it work?');
    expect(criterion.kind).toBe('model-graded');
    expect(criterion.label).toMatch(/^\[model-graded\]/);
  });
});

describe('call recorder', () => {
  it('pairs each result with the oldest unsettled call of that name', () => {
    const recorder = createCallRecorder();
    recorder.onToolUse('Read', { path: 'a' });
    recorder.onToolUse('Read', { path: 'b' });
    recorder.onToolResult('Read', 'body-a', false);
    recorder.onToolResult('Read', 'body-b', true);
    const calls = recorder.calls();
    expect(calls.map((c) => c.input['path'])).toEqual(['a', 'b']);
    expect(calls.map((c) => c.output)).toEqual(['body-a', 'body-b']);
    expect(calls.map((c) => c.isError)).toEqual([false, true]);
  });

  it('keeps different tool names in separate queues', () => {
    const recorder = createCallRecorder();
    recorder.onToolUse('Read', { path: 'a' });
    recorder.onToolUse('Edit', { path: 'b' });
    recorder.onToolResult('Edit', 'edited', false);
    recorder.onToolResult('Read', 'read', false);
    const calls = recorder.calls();
    expect(defined(calls[0]).output).toBe('read');
    expect(defined(calls[1]).output).toBe('edited');
  });

  it('marks a call that never produced a result as unsettled', () => {
    const recorder = createCallRecorder();
    recorder.onToolUse('Bash', { command: 'sleep 99' });
    expect(defined(recorder.calls()[0]).settled).toBe(false);
  });

  it('returns detached copies so a criterion cannot mutate the record', () => {
    const recorder = createCallRecorder();
    recorder.onToolUse('Read', { path: 'a' });
    const first = recorder.calls();
    defined(first[0]).input['path'] = 'tampered';
    expect(defined(recorder.calls()[0]).input['path']).toBe('a');
  });
});

describe('fixture workspace', () => {
  it('materialises nested files and disposes them', async () => {
    const fixture = await createFixture({ 'src/deep/a.ts': 'export const a = 1;\n' });
    expect(readFileSync(join(fixture.root, 'src/deep/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    await fixture.dispose();
    expect(existsSync(fixture.root)).toBe(false);
  });

  it('refuses a fixture path that climbs out of the workspace', async () => {
    await expect(createFixture({ '../escape.txt': 'no' })).rejects.toThrow(/escapes the workspace/);
  });

  it('withEvalWorkspace points the guard at the fixture and restores it after', async () => {
    process.env['ASTERISK_WORKSPACE'] = workspace;
    _resetWorkspaceForTesting();
    const fixture = await createFixture({});
    const seen = await withEvalWorkspace(fixture.root, async () => workspaceRoot());
    expect(seen).toBe(fixture.root);
    expect(workspaceRoot()).toBe(workspace);
    await fixture.dispose();
  });

  it('restores the guard even when the body throws', async () => {
    process.env['ASTERISK_WORKSPACE'] = workspace;
    _resetWorkspaceForTesting();
    const fixture = await createFixture({});
    await expect(
      withEvalWorkspace(fixture.root, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(workspaceRoot()).toBe(workspace);
    await fixture.dispose();
  });

  it('renderPrompt substitutes every occurrence of the workspace token', () => {
    expect(renderPrompt('a {{workspace}} b {{workspace}}', '/tmp/x')).toBe('a /tmp/x b /tmp/x');
    expect(renderPrompt('no token here', '/tmp/x')).toBe('no token here');
  });
});

describe('scripted provider', () => {
  it('advances the turn counter and hands the script the live message list', async () => {
    const seen: number[] = [];
    const provider = createScriptedProvider(({ turn, messages }) => {
      seen.push(turn);
      return say(`turn ${turn} saw ${messages.length} message(s)`);
    }, '/tmp/ws');
    await provider.send({ system: '', messages: [], tools: [] });
    await provider.send({ system: '', messages: [{ role: 'user', content: [] }], tools: [] });
    expect(seen).toEqual([0, 1]);
  });

  it('throws when the script runs out, so an unplanned path cannot grade as a pass', async () => {
    const provider = createScriptedProvider(() => null, '/tmp/ws');
    await expect(provider.send({ system: '', messages: [], tools: [] })).rejects.toThrow(
      /script exhausted/,
    );
  });
});

describe('script helpers', () => {
  it('lastCallFailed reads the most recent tool_result batch', () => {
    const failed = lastCallFailed([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hm' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: 'bad', is_error: true }],
      },
    ]);
    expect(failed).toBe(true);
  });

  it('lastCallFailed is false with no tool results at all', () => {
    expect(lastCallFailed([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(false);
  });

  it('toolBatch emits every call in one response', () => {
    const response = toolBatch([
      { id: 'a', name: 'Read', input: { path: '1' } },
      { id: 'b', name: 'Read', input: { path: '2' } },
    ]);
    expect(response.content).toHaveLength(2);
    expect(response.stopReason).toBe('tool_use');
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  Runner — the part that turns all of the above into a verdict
// ─────────────────────────────────────────────────────────────────────────

function tinyScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    name: 'tiny',
    description: 'writes a file and stops',
    prompt: 'edit a.txt',
    files: { 'a.txt': 'before\n' },
    criteria: [fileContains('a.txt', 'after')],
    script: ({ turn, workspace: ws }) => {
      if (turn === 0) {
        return toolUse('e1', 'Edit', {
          path: join(ws, 'a.txt'),
          oldString: 'before',
          newString: 'after',
        });
      }
      if (turn === 1) return say('done');
      return null;
    },
    ...over,
  };
}

describe('runScenario', () => {
  it('passes when every criterion holds', async () => {
    const result = await runScenario(tinyScenario());
    expect(result.status).toBe('pass');
    expect(defined(result.criteria[0]).passed).toBe(true);
  });

  it('fails with the reason attached when a criterion does not hold', async () => {
    const result = await runScenario(
      tinyScenario({ criteria: [fileContains('a.txt', 'never-written')] }),
    );
    expect(result.status).toBe('fail');
    expect(defined(result.criteria[0]).passed).toBe(false);
    expect(defined(result.criteria[0]).detail).toMatch(/no "never-written"/);
  });

  it('reports an exhausted script as error, never as pass', async () => {
    const result = await runScenario(tinyScenario({ script: () => null }));
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/script exhausted/);
    // The criteria are still listed, so the report shows what went unchecked.
    expect(defined(result.criteria[0]).skipped).toBe(true);
  });

  it('a criterion that throws counts as a failure, not a silent pass', async () => {
    const exploding: Criterion = {
      label: 'explodes',
      kind: 'objective',
      check: () => {
        throw new Error('bad check');
      },
    };
    const result = await runScenario(tinyScenario({ criteria: [exploding] }));
    expect(result.status).toBe('fail');
    expect(defined(result.criteria[0]).detail).toMatch(/criterion threw: bad check/);
  });

  it('a skipped criterion cannot rescue a failing scenario', async () => {
    const result = await runScenario(
      tinyScenario({ criteria: [modelGraded('is it good?'), fileContains('a.txt', 'nope')] }),
    );
    expect(result.status).toBe('fail');
    expect(defined(result.criteria[0]).skipped).toBe(true);
  });

  it('a skipped criterion alone still lets the objective ones decide', async () => {
    const result = await runScenario(tinyScenario({ criteria: [modelGraded('good?')] }));
    expect(result.status).toBe('pass');
  });

  it('honours allowedTools by refusing an excluded tool at execution time', async () => {
    const result = await runScenario(
      tinyScenario({
        allowedTools: ['Read'],
        criteria: [toolErrored('Edit', /not available/), fileContains('a.txt', 'before')],
      }),
    );
    expect(result.status).toBe('pass');
  });

  it('cleans the fixture up by default and keeps it on request', async () => {
    const plain = await runScenario(tinyScenario());
    expect(plain.workspace).toBeUndefined();
    const kept = await runScenario(tinyScenario(), { keepWorkspace: true });
    expect(existsSync(defined(kept.workspace))).toBe(true);
    await rm(defined(kept.workspace), { recursive: true, force: true });
  });

  it('leaves the ambient workspace guard exactly as it found it', async () => {
    process.env['ASTERISK_WORKSPACE'] = workspace;
    _resetWorkspaceForTesting();
    await runScenario(tinyScenario());
    expect(workspaceRoot()).toBe(workspace);
  });

  it('aborts a scenario that outruns its deadline', async () => {
    const stalling = tinyScenario({
      script: () => toolUse('b1', 'Bash', { command: 'sleep 30' }),
      criteria: [terminalReason('end-turn')],
    });
    const result = await runScenario(stalling, { timeoutMs: 200 });
    expect(result.status).not.toBe('pass');
  }, 20_000);
});

describe('runSuite and selection', () => {
  it('tallies pass/fail/error and reports scripted mode', async () => {
    const suite = await runSuite([
      tinyScenario({ name: 'good' }),
      tinyScenario({ name: 'bad', criteria: [fileContains('a.txt', 'nope')] }),
      tinyScenario({ name: 'broken', script: () => null }),
    ]);
    expect(suite.mode).toBe('scripted');
    expect([suite.passed, suite.failed, suite.errored]).toEqual([1, 1, 1]);
  });

  it('selectScenarios filters case-insensitively, and no filter means everything', () => {
    const all = [tinyScenario({ name: 'edit-fixes-bug' }), tinyScenario({ name: 'multi-tool' })];
    expect(selectScenarios(all, []).length).toBe(2);
    expect(selectScenarios(all, ['EDIT']).map((s) => s.name)).toEqual(['edit-fixes-bug']);
    expect(selectScenarios(all, ['nothing']).length).toBe(0);
  });
});

describe('report', () => {
  it('expands every criterion for a failure and stays quiet for a pass', async () => {
    const suite = await runSuite([
      tinyScenario({ name: 'good' }),
      tinyScenario({ name: 'bad', criteria: [fileContains('a.txt', 'nope')] }),
    ]);
    const text = formatSuite(suite);
    expect(text).toContain('✓ good');
    expect(text).toContain('✗ bad');
    expect(text).toMatch(/no "nope"/);
    // The scripted caveat is stated every time, so a green run is never
    // mistaken for evidence about a model.
    expect(text).toMatch(/scripted mode replays canned model responses/);
  });

  it('json output carries status and criterion kinds but not transcripts', async () => {
    const suite = await runSuite([tinyScenario({ criteria: [modelGraded('good?')] })]);
    const parsed = JSON.parse(suiteToJson(suite));
    expect(parsed.results[0].status).toBe('pass');
    expect(parsed.results[0].criteria[0].kind).toBe('model-graded');
    expect(parsed.results[0].transcript).toBeUndefined();
  });
});

describe('cli', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      streams: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    };
  }

  it('parses flags, filters and --timeout', () => {
    const flags = parseArgs(['--live', '--json', '--timeout', '30', 'edit', 'rename']);
    expect(flags.live).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.timeoutMs).toBe(30_000);
    expect(flags.filters).toEqual(['edit', 'rename']);
  });

  it('rejects an unknown flag and a bad timeout', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow(/positive number/);
    expect(() => parseArgs(['--timeout'])).toThrow(/positive number/);
  });

  it('--list prints names without running anything', async () => {
    const { out, streams } = capture();
    const code = await runEvalCli(['--list'], streams, [tinyScenario({ name: 'only-one' })]);
    expect(code).toBe(0);
    expect(out.join('')).toContain('only-one');
  });

  it('exits 2 on a bad flag and on a filter that matches nothing', async () => {
    const bad = capture();
    expect(await runEvalCli(['--nope'], bad.streams, [])).toBe(2);
    expect(bad.err.join('')).toMatch(/unknown flag/);
    const empty = capture();
    expect(await runEvalCli(['ghost'], empty.streams, [tinyScenario()])).toBe(2);
  });

  it('exits 0 when the suite is green and 1 when it is not', async () => {
    const green = capture();
    expect(await runEvalCli([], green.streams, [tinyScenario()])).toBe(0);
    const red = capture();
    const code = await runEvalCli([], red.streams, [
      tinyScenario({ criteria: [fileContains('a.txt', 'nope')] }),
    ]);
    expect(code).toBe(1);
  });
});
