// Scenario eval harness — the shared vocabulary.
//
// The unit suite proves a function does what its name says. It cannot answer
// the question that actually matters: given a prompt, a workspace and a model,
// does the loop finish the job? A scenario is that question written down so a
// machine can grade the answer — a prompt, an optional fixture workspace, and
// criteria that read the filesystem and the tool transcript rather than the
// prose.
//
// Scenarios are typed TypeScript rather than JSON/YAML on purpose:
//   * criteria are predicates, and a data language would need an interpreter
//     plus a mini-DSL for "file contains X" — a second, weaker type system;
//   * the offline script has to *branch* on what the tools returned (that is
//     the whole point of the tool-error-recovery scenario), which is code;
//   * it matches how the rest of the repo ships bundled content
//     (skills/bundled.ts, agents/bundled.ts, output-styles/styles.ts).
// The criteria constructors in criteria.ts keep the declaration reading like
// data anyway, so a scenario is still a description, not a program.

import type { TerminalReason } from '../agent/loop.ts';
import type { Message, Provider, ProviderResponse } from '../types/messages.ts';

/** One tool call the agent made, as the runner observed it. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Empty until the call settles; see the pairing caveat in recorder.ts. */
  output: string;
  isError: boolean;
  /** False when a call was started but never produced a result (aborted turn). */
  settled: boolean;
}

/** Everything a criterion is allowed to look at. Deliberately narrow: a
 *  criterion that could reach the live provider could grade itself. */
export interface Transcript {
  /** Absolute path to the materialised fixture workspace. */
  workspace: string;
  calls: readonly ToolCall[];
  finalText: string;
  reason: TerminalReason;
}

/** Out-of-band inputs a criterion may need. Only the model-graded criterion
 *  uses these; objective criteria ignore the argument entirely. */
export interface CriterionEnv {
  grader?: Provider;
  signal?: AbortSignal;
}

/** `objective` = decided by the filesystem or the transcript, reproducible.
 *  `model-graded` = decided by a model, and therefore not. The distinction is
 *  carried into the report so nobody reads the two as equally trustworthy. */
export type CriterionKind = 'objective' | 'model-graded';

export interface CriterionOutcome {
  passed: boolean;
  /** Why — always populated. A bare `false` is useless in a failure report. */
  detail: string;
  /** Set when the criterion could not be evaluated at all. A skipped criterion
   *  never counts as a pass and never fails the scenario; it is reported and
   *  otherwise ignored. */
  skipped?: boolean;
}

export interface Criterion {
  label: string;
  kind: CriterionKind;
  check(transcript: Transcript, env: CriterionEnv): Promise<CriterionOutcome> | CriterionOutcome;
}

/** What the offline script sees when it decides the next model response. */
export interface ScriptContext {
  /** 0-based index of this model call within the scenario run. */
  turn: number;
  /** The conversation exactly as the loop is about to send it, so a script can
   *  branch on the last tool_result instead of assuming a fixed sequence. */
  messages: readonly Message[];
  workspace: string;
}

/** Returns the response the fake model gives for this turn, or null to signal
 *  "the script did not expect to be called again" — which the runner reports
 *  as a scenario *error*, never as a pass. */
export type ScenarioScript = (ctx: ScriptContext) => ProviderResponse | null;

export interface Scenario {
  /** Stable identifier — used for --filter and in reports. */
  name: string;
  description: string;
  /** The user turn. `{{workspace}}` is substituted with the absolute fixture
   *  path, which is the only runtime value a prompt can need. */
  prompt: string;
  /** Fixture files, keyed by path relative to the workspace root. Nested
   *  directories are created as needed. */
  files?: Readonly<Record<string, string>>;
  /** Restricts the tools the agent may use, exactly like a sub-agent type. */
  allowedTools?: readonly string[];
  maxTurns?: number;
  criteria: readonly Criterion[];
  /** The offline stand-in for a model. Used when no live provider is passed. */
  script: ScenarioScript;
}

export type ScenarioStatus = 'pass' | 'fail' | 'error';

export interface CriterionResult {
  label: string;
  kind: CriterionKind;
  passed: boolean;
  skipped: boolean;
  detail: string;
}

export interface ScenarioResult {
  name: string;
  description: string;
  status: ScenarioStatus;
  durationMs: number;
  criteria: readonly CriterionResult[];
  transcript?: Transcript;
  /** Set when the run itself blew up — a thrown provider error, an exhausted
   *  script, a timeout. Distinct from `fail`, which means the agent ran fine
   *  and did the wrong thing. */
  error?: string;
  /** Populated only when the workspace was deliberately kept for inspection. */
  workspace?: string;
}

export interface SuiteResult {
  /** `scripted` = offline, no model involved. `live` = real provider. */
  mode: 'scripted' | 'live';
  results: readonly ScenarioResult[];
  passed: number;
  failed: number;
  errored: number;
  durationMs: number;
}
