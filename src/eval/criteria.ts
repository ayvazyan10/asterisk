// Criterion constructors — the declarative surface scenarios are written in.
//
// Every criterion here is decided by the filesystem or by the recorded tool
// transcript, so the same scenario grades identically offline and against a
// live model. The one exception is modelGraded() at the bottom, which is
// deliberately quarantined and labelled.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TerminalReason } from '../agent/loop.ts';
import type { Criterion, CriterionOutcome, ToolCall, Transcript } from './types.ts';

/** Resolves a scenario-relative path against the fixture workspace. Absolute
 *  paths pass through, which is how the escape-path scenario names a target
 *  deliberately outside the workspace. */
function locate(transcript: Transcript, path: string): string {
  return resolve(transcript.workspace, path);
}

function readOrNull(absolute: string): string | null {
  if (!existsSync(absolute)) return null;
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function objective(label: string, check: (t: Transcript) => CriterionOutcome): Criterion {
  return { label, kind: 'objective', check };
}

function verdict(passed: boolean, detail: string): CriterionOutcome {
  return { passed, detail };
}

// ─────────────────────────────────────────────────────────────────────────
//  Filesystem
// ─────────────────────────────────────────────────────────────────────────

export function fileContains(path: string, needle: string): Criterion {
  return objective(`${path} contains ${JSON.stringify(needle)}`, (t) => {
    const body = readOrNull(locate(t, path));
    if (body === null) return verdict(false, `${path} does not exist`);
    return body.includes(needle)
      ? verdict(true, `found in ${path}`)
      : verdict(false, `${path} exists but has no ${JSON.stringify(needle)}`);
  });
}

export function fileLacks(path: string, needle: string): Criterion {
  return objective(`${path} no longer contains ${JSON.stringify(needle)}`, (t) => {
    const body = readOrNull(locate(t, path));
    if (body === null) return verdict(false, `${path} does not exist`);
    return body.includes(needle)
      ? verdict(false, `${path} still contains ${JSON.stringify(needle)}`)
      : verdict(true, `absent from ${path}`);
  });
}

export function fileMatches(path: string, pattern: RegExp): Criterion {
  return objective(`${path} matches ${pattern}`, (t) => {
    const body = readOrNull(locate(t, path));
    if (body === null) return verdict(false, `${path} does not exist`);
    return pattern.test(body)
      ? verdict(true, `matched in ${path}`)
      : verdict(false, `${path} does not match ${pattern}`);
  });
}

/** Proves a file was NOT created — the shape a refusal takes on disk. */
export function fileAbsent(path: string): Criterion {
  return objective(`${path} was not created`, (t) => {
    const absolute = locate(t, path);
    return existsSync(absolute) ? verdict(false, `${absolute} exists`) : verdict(true, 'absent');
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Tool transcript
// ─────────────────────────────────────────────────────────────────────────

function callsNamed(transcript: Transcript, name: string): ToolCall[] {
  return transcript.calls.filter((c) => c.name === name);
}

export interface ToolCalledOptions {
  /** Exact call count. */
  times?: number;
  /** Minimum call count. Ignored when `times` is set. */
  atLeast?: number;
  /** Narrows to calls whose input satisfies this. */
  withInput?: (input: Record<string, unknown>) => boolean;
}

export function toolCalled(name: string, opts: ToolCalledOptions = {}): Criterion {
  const bound =
    opts.times !== undefined ? `exactly ${opts.times}×` : `at least ${opts.atLeast ?? 1}×`;
  return objective(`${name} called ${bound}`, (t) => {
    const matched = opts.withInput
      ? callsNamed(t, name).filter((c) => {
          try {
            return opts.withInput?.(c.input) === true;
          } catch {
            // A throwing predicate is the scenario author's bug, but it must not
            // take down the whole run — report it as a miss and move on.
            return false;
          }
        })
      : callsNamed(t, name);
    const n = matched.length;
    if (opts.times !== undefined) {
      return verdict(n === opts.times, `${name} called ${n}× (wanted ${opts.times})`);
    }
    const floor = opts.atLeast ?? 1;
    return verdict(n >= floor, `${name} called ${n}× (wanted ≥ ${floor})`);
  });
}

export function toolNotCalled(name: string): Criterion {
  return objective(`${name} never called`, (t) => {
    const n = callsNamed(t, name).length;
    return verdict(n === 0, n === 0 ? 'never called' : `called ${n}×`);
  });
}

/** The named tools appear in this order somewhere in the transcript. A
 *  subsequence, not a prefix — unrelated calls in between are fine, because
 *  pinning the exact call list would make every scenario brittle against a
 *  model that reads one extra file. */
export function toolSequence(names: readonly string[]): Criterion {
  return objective(`tools called in order: ${names.join(' → ')}`, (t) => {
    let cursor = 0;
    for (const call of t.calls) {
      if (cursor < names.length && call.name === names[cursor]) cursor++;
    }
    const actual = t.calls.map((c) => c.name).join(' → ') || '(none)';
    return cursor === names.length
      ? verdict(true, 'sequence present')
      : verdict(false, `stopped at ${names[cursor]}; actual order was ${actual}`);
  });
}

/** At least one call to `name` came back as an error, optionally matching a
 *  pattern. This is how a scenario asserts that a boundary actually refused. */
export function toolErrored(name: string, pattern?: RegExp): Criterion {
  const suffix = pattern ? ` matching ${pattern}` : '';
  return objective(`${name} returned an error${suffix}`, (t) => {
    const errors = callsNamed(t, name).filter((c) => c.isError);
    if (errors.length === 0) return verdict(false, `no failing ${name} call`);
    if (!pattern) return verdict(true, `${errors.length} failing ${name} call(s)`);
    const hit = errors.find((c) => pattern.test(c.output));
    return hit
      ? verdict(true, `matched: ${firstLine(hit.output)}`)
      : verdict(
          false,
          `${errors.length} error(s) but none matched: ${firstLine(errors[0]?.output)}`,
        );
  });
}

/** Every call to `name` succeeded. Pairs with toolCalled to say "it ran and it
 *  worked", which toolCalled alone does not. */
export function toolSucceeded(name: string): Criterion {
  return objective(`every ${name} call succeeded`, (t) => {
    const all = callsNamed(t, name);
    if (all.length === 0) return verdict(false, `${name} was never called`);
    const failed = all.filter((c) => c.isError);
    return failed.length === 0
      ? verdict(true, `${all.length} successful call(s)`)
      : verdict(false, `${failed.length}/${all.length} failed: ${firstLine(failed[0]?.output)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Turn outcome
// ─────────────────────────────────────────────────────────────────────────

export function finalTextMatches(pattern: RegExp): Criterion {
  return objective(`final reply matches ${pattern}`, (t) =>
    pattern.test(t.finalText)
      ? verdict(true, 'matched')
      : verdict(false, `final reply was ${JSON.stringify(truncate(t.finalText))}`),
  );
}

export function terminalReason(expected: TerminalReason): Criterion {
  return objective(`turn ended with "${expected}"`, (t) =>
    verdict(t.reason === expected, `ended with "${t.reason}"`),
  );
}

/** Escape hatch for a check the constructors above cannot express. Keep the
 *  predicate objective — the whole point of this file is that a criterion is
 *  something a machine can settle. */
export function custom(label: string, predicate: (t: Transcript) => boolean | string): Criterion {
  return objective(label, (t) => {
    const result = predicate(t);
    // A returned string is a failure reason; `true` passes, `false` fails bare.
    if (typeof result === 'string') return verdict(false, result);
    return verdict(result, result ? 'ok' : 'predicate returned false');
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Model-graded — read the warning before reaching for this
// ─────────────────────────────────────────────────────────────────────────

const GRADER_INSTRUCTION = [
  'You are grading an AI agent transcript. Answer the question below about it.',
  'Reply with exactly one line: "PASS <reason>" or "FAIL <reason>".',
  'Do not use any tools. Do not explain beyond the one line.',
].join('\n');

/**
 * A criterion answered by a model instead of by the filesystem.
 *
 * **Its weaknesses, in full.** The grader is the same class of component as the
 * thing under test, so a shared blind spot passes unnoticed. It is not
 * reproducible — the same transcript can be graded differently twice. It is
 * steerable: text the agent itself wrote is inside the grading prompt, so an
 * agent that says "I completed the task successfully" is arguing its own case.
 * It costs a model call, so it cannot run in CI at all.
 *
 * Consequently: with no grader configured it reports **skipped**, and a skipped
 * criterion can never turn a failing scenario green — the runner ignores it
 * when deciding status. Use it as commentary next to objective criteria, never
 * as the only thing a scenario checks. A scenario whose criteria are all
 * model-graded proves nothing.
 */
export function modelGraded(question: string): Criterion {
  return {
    label: `[model-graded] ${question}`,
    kind: 'model-graded',
    async check(transcript, env) {
      if (!env.grader) {
        return { passed: false, skipped: true, detail: 'skipped — no grader provider configured' };
      }
      try {
        const response = await env.grader.send({
          system: GRADER_INSTRUCTION,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: gradingPrompt(transcript, question) }],
            },
          ],
          tools: [],
          ...(env.signal ? { signal: env.signal } : {}),
        });
        const text = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        const passed = /^\s*PASS\b/i.test(text);
        return { passed, detail: firstLine(text) || '(grader returned no text)' };
      } catch (error) {
        // A grader that cannot be reached must not fail the scenario — that
        // would make an unrelated network problem look like an agent defect.
        return {
          passed: false,
          skipped: true,
          detail: `skipped — grader failed: ${message(error)}`,
        };
      }
    },
  };
}

function gradingPrompt(transcript: Transcript, question: string): string {
  const calls = transcript.calls
    .map(
      (c) =>
        `- ${c.name}(${truncate(JSON.stringify(c.input), 200)}) → ${c.isError ? 'ERROR' : 'ok'}`,
    )
    .join('\n');
  return [
    `Question: ${question}`,
    '',
    'Tool calls the agent made:',
    calls || '(none)',
    '',
    "The agent's final reply:",
    truncate(transcript.finalText, 2000),
  ].join('\n');
}

function firstLine(text: string | undefined): string {
  return truncate((text ?? '').split('\n')[0] ?? '', 160);
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
