// The shipped scenarios, run offline.
//
// This is the CI gate for the eval suite: `bun run test` executes every
// scenario against its scripted responses, so the harness, the criteria, the
// tools and the loop are all exercised end-to-end without a model anywhere in
// the picture. `asterisk eval --live` runs the identical criteria against a
// real provider when someone wants to know about the model instead.

import { describe, expect, it } from 'vitest';

import { afterEach, beforeEach } from 'vitest';
import { runScenario } from '../src/eval/runner.ts';
import { SCENARIOS } from '../src/eval/scenarios/index.ts';
import { _resetWorkspaceForTesting } from '../src/tools/workspace.ts';

let prevWorkspace: string | undefined;

beforeEach(() => {
  prevWorkspace = process.env['ASTERISK_WORKSPACE'];
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env['ASTERISK_WORKSPACE'];
  else process.env['ASTERISK_WORKSPACE'] = prevWorkspace;
  _resetWorkspaceForTesting();
});

describe('shipped scenarios (scripted)', () => {
  it('ships a set with unique names and at least one objective criterion each', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const scenario of SCENARIOS) {
      const objective = scenario.criteria.filter((c) => c.kind === 'objective');
      // A scenario graded only by a model proves nothing in CI, where every
      // model-graded criterion skips — it would be permanently green.
      expect(objective.length, `${scenario.name} has no objective criterion`).toBeGreaterThan(0);
    }
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: ${scenario.description}`, async () => {
      const result = await runScenario(scenario);
      const failures = result.criteria
        .filter((c) => !c.passed && !c.skipped)
        .map((c) => `${c.label} — ${c.detail}`);
      expect(result.error ?? '', `${scenario.name} errored`).toBe('');
      expect(failures, `${scenario.name} failed criteria`).toEqual([]);
      expect(result.status).toBe('pass');
    }, 30_000);
  }

  it('every scenario keeps its model-graded criteria skipped without a grader', async () => {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(scenario);
      for (const criterion of result.criteria) {
        if (criterion.kind === 'model-graded') expect(criterion.skipped).toBe(true);
      }
    }
  }, 60_000);
});
