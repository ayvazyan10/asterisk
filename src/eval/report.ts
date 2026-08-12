// Rendering for suite results — human text and machine JSON.

import type { CriterionResult, ScenarioResult, SuiteResult } from './types.ts';

const MARK: Record<ScenarioResult['status'], string> = {
  pass: '✓',
  fail: '✗',
  error: '!',
};

export function formatSuite(suite: SuiteResult): string {
  const lines: string[] = [
    `Asterisk eval · ${suite.mode} · ${suite.results.length} scenario${suite.results.length === 1 ? '' : 's'}`,
    '',
  ];
  for (const result of suite.results) lines.push(...formatScenario(result));
  lines.push('');
  lines.push(summaryLine(suite));
  if (suite.mode === 'scripted') {
    // Said every run, because a green scripted suite is easy to over-read: it
    // proves the harness and the loop, not the model.
    lines.push('(scripted mode replays canned model responses — it exercises the');
    lines.push(' loop, tools and criteria, not a real model. Use --live for that.)');
  }
  return lines.join('\n');
}

function formatScenario(result: ScenarioResult): string[] {
  const graded = result.criteria.filter((c) => !c.skipped);
  const met = graded.filter((c) => c.passed).length;
  const head = `${MARK[result.status]} ${result.name.padEnd(30)} ${met}/${graded.length} criteria · ${result.durationMs}ms`;
  const lines = [head];
  if (result.error) lines.push(`    error: ${result.error}`);
  // A passing scenario only shows what was skipped; a failing one shows
  // everything, because "which of the five did not hold" is the whole question.
  const shown =
    result.status === 'pass' ? result.criteria.filter((c) => c.skipped) : result.criteria;
  for (const criterion of shown) lines.push(`    ${formatCriterion(criterion)}`);
  if (result.workspace) lines.push(`    workspace kept at ${result.workspace}`);
  return lines;
}

function formatCriterion(criterion: CriterionResult): string {
  const mark = criterion.skipped ? '·' : criterion.passed ? '✓' : '✗';
  return `${mark} ${criterion.label} — ${criterion.detail}`;
}

function summaryLine(suite: SuiteResult): string {
  const parts = [`${suite.passed} passed`];
  if (suite.failed > 0) parts.push(`${suite.failed} failed`);
  if (suite.errored > 0) parts.push(`${suite.errored} errored`);
  return `${parts.join(' · ')} · ${suite.durationMs}ms`;
}

/** Machine-readable form. Transcripts are dropped — they carry whole file
 *  contents and tool output, which is inspection material, not a result. */
export function suiteToJson(suite: SuiteResult): string {
  return JSON.stringify(
    {
      mode: suite.mode,
      passed: suite.passed,
      failed: suite.failed,
      errored: suite.errored,
      durationMs: suite.durationMs,
      results: suite.results.map((r) => ({
        name: r.name,
        status: r.status,
        durationMs: r.durationMs,
        ...(r.error ? { error: r.error } : {}),
        criteria: r.criteria.map((c) => ({
          label: c.label,
          kind: c.kind,
          passed: c.passed,
          skipped: c.skipped,
          detail: c.detail,
        })),
      })),
    },
    null,
    2,
  );
}

export function formatScenarioList(
  scenarios: readonly { name: string; description: string }[],
): string {
  const lines = [`Scenarios · ${scenarios.length}`];
  for (const s of scenarios) lines.push(`  ${s.name.padEnd(30)} ${s.description}`);
  return lines.join('\n');
}
