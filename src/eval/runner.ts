// Scenario runner — materialise a workspace, drive one agent turn against it,
// then grade the result.
//
// Deliberately austere about what it feeds the loop: no rules, no souls, no
// hooks, no output style. Those are all user-machine state, and a harness whose
// verdict changes because someone dropped a markdown file in ~/.asterisk/rules
// is not measuring the agent. The only inputs are the scenario and the
// provider.

import { type AgentState, createAgentState, runAgentTurn } from '../agent/loop.ts';
import type { Provider } from '../types/messages.ts';
import { createCallRecorder } from './recorder.ts';
import { createScriptedProvider } from './script-provider.ts';
import type {
  Criterion,
  CriterionEnv,
  CriterionResult,
  Scenario,
  ScenarioResult,
  SuiteResult,
  Transcript,
} from './types.ts';
import { createFixture, renderPrompt, withEvalWorkspace } from './workspace.ts';

/** A scenario that has not finished in two minutes is stuck, not slow. */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 16;

export interface RunScenarioOptions {
  /** A live provider. When absent the scenario's own script runs instead. */
  provider?: Provider;
  /** Provider used to answer model-graded criteria. Absent → those skip. */
  grader?: Provider;
  maxTurns?: number;
  timeoutMs?: number;
  /** Leave the fixture directory on disk so a failure can be inspected. */
  keepWorkspace?: boolean;
  signal?: AbortSignal;
}

export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOptions = {},
): Promise<ScenarioResult> {
  const started = Date.now();
  const fixture = await createFixture(scenario.files ?? {});
  const base = {
    name: scenario.name,
    description: scenario.description,
    ...(opts.keepWorkspace ? { workspace: fixture.root } : {}),
  };
  try {
    const transcript = await withEvalWorkspace(fixture.root, () =>
      driveTurn(scenario, fixture.root, opts),
    );
    const env: CriterionEnv = {
      ...(opts.grader ? { grader: opts.grader } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    const criteria = await gradeAll(scenario.criteria, transcript, env);
    const failed = criteria.some((c) => !c.passed && !c.skipped);
    return {
      ...base,
      status: failed ? 'fail' : 'pass',
      durationMs: Date.now() - started,
      criteria,
      transcript,
    };
  } catch (error) {
    // A thrown run is neither a pass nor an ordinary fail: the agent never got
    // to be wrong. Criteria are reported unevaluated so the report still shows
    // what the scenario intended to check.
    return {
      ...base,
      status: 'error',
      durationMs: Date.now() - started,
      criteria: scenario.criteria.map(unevaluated),
      error: describe(error),
    };
  } finally {
    if (!opts.keepWorkspace) await fixture.dispose();
  }
}

/** Runs the agent for one scenario and returns what the criteria may inspect. */
async function driveTurn(
  scenario: Scenario,
  workspace: string,
  opts: RunScenarioOptions,
): Promise<Transcript> {
  const provider: Provider = opts.provider ?? createScriptedProvider(scenario.script, workspace);
  const recorder = createCallRecorder();
  const state: AgentState = createAgentState();
  const timer = startDeadline(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  try {
    const result = await runAgentTurn(provider, state, renderPrompt(scenario.prompt, workspace), {
      maxTurns: scenario.maxTurns ?? opts.maxTurns ?? DEFAULT_MAX_TURNS,
      // A summariser call would cost a model round-trip and, offline, would hit
      // the scripted provider and eat a turn the script did not budget for.
      summariseDropped: false,
      signal: timer.signal,
      session: { id: `eval:${scenario.name}`, scope: 'unknown' },
      ...(scenario.allowedTools ? { allowedTools: scenario.allowedTools } : {}),
      onToolUse: recorder.onToolUse,
      onToolResult: recorder.onToolResult,
    });
    return {
      workspace,
      calls: recorder.calls(),
      finalText: result.finalText,
      reason: result.reason,
    };
  } finally {
    timer.dispose();
  }
}

async function gradeAll(
  criteria: readonly Criterion[],
  transcript: Transcript,
  env: CriterionEnv,
): Promise<CriterionResult[]> {
  const results: CriterionResult[] = [];
  for (const criterion of criteria) {
    try {
      const outcome = await criterion.check(transcript, env);
      results.push({
        label: criterion.label,
        kind: criterion.kind,
        passed: outcome.passed,
        skipped: outcome.skipped === true,
        detail: outcome.detail,
      });
    } catch (error) {
      // A criterion that throws is a broken check, and a broken check must read
      // as a failure — silently passing it would hide the scenario entirely.
      results.push({
        label: criterion.label,
        kind: criterion.kind,
        passed: false,
        skipped: false,
        detail: `criterion threw: ${describe(error)}`,
      });
    }
  }
  return results;
}

export interface RunSuiteOptions extends RunScenarioOptions {
  onResult?(result: ScenarioResult): void;
}

/**
 * Runs scenarios one at a time. Sequential is not laziness: the workspace guard
 * root is process-global (see withEvalWorkspace), so two concurrent scenarios
 * would write into each other's fixtures.
 */
export async function runSuite(
  scenarios: readonly Scenario[],
  opts: RunSuiteOptions = {},
): Promise<SuiteResult> {
  const started = Date.now();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, opts);
    results.push(result);
    opts.onResult?.(result);
  }
  return {
    mode: opts.provider ? 'live' : 'scripted',
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    errored: results.filter((r) => r.status === 'error').length,
    durationMs: Date.now() - started,
  };
}

/** Case-insensitive substring match on scenario names. No filters → everything. */
export function selectScenarios(all: readonly Scenario[], filters: readonly string[]): Scenario[] {
  if (filters.length === 0) return [...all];
  const needles = filters.map((f) => f.toLowerCase());
  return all.filter((s) => needles.some((n) => s.name.toLowerCase().includes(n)));
}

interface Deadline {
  signal: AbortSignal;
  dispose(): void;
}

/** Own controller rather than AbortSignal.any + timeout, so the abort carries a
 *  reason the report can print instead of a bare DOMException. */
function startDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  const onParent = (): void => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener('abort', onParent, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`scenario timed out after ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}

function unevaluated(criterion: Criterion): CriterionResult {
  return {
    label: criterion.label,
    kind: criterion.kind,
    passed: false,
    skipped: true,
    detail: 'not evaluated — the run errored',
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
