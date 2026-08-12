// Human-readable rendering of skill validation, shared by `/skills` (a
// one-line footer) and `/skills validate` (the full report). Kept out of the
// loader so discovery stays free of presentation, and out of the command
// registry so the wording can be tested without a REPL context.

import { BUNDLED_SKILLS } from './bundled.ts';
import type { SkillLoad } from './loader.ts';
import { type SkillIssue, validateSkill } from './schema.ts';

export function countBySeverity(issues: SkillIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}

/** One line for the plain `/skills` listing, or null when nothing is wrong. */
export function skillIssueSummary(issues: SkillIssue[]): string | null {
  if (issues.length === 0) return null;
  const { errors, warnings } = countBySeverity(issues);
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} not loaded`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return `! ${parts.join(', ')} — run /skills validate`;
}

export function formatSkillReport(load: SkillLoad): string {
  const { errors, warnings } = countBySeverity(load.issues);
  const lines = [
    `Skills · ${load.skills.length} loaded · ${errors} error${errors === 1 ? '' : 's'} · ` +
      `${warnings} warning${warnings === 1 ? '' : 's'}`,
  ];

  // Errors first: those are the skills the user cannot run at all.
  const ordered = [...load.issues].sort((a, b) => severityRank(a) - severityRank(b));
  for (const issue of ordered) {
    lines.push('');
    lines.push(`  ${issue.severity === 'error' ? '✗' : '!'} ${issue.skill}`);
    lines.push(`      ${issue.path}`);
    lines.push(`      ${issue.message}`);
  }

  // The bundled set has no files to inspect, so it is checked against the
  // same schema in memory — a bad bundled skill is a shipping bug, not a
  // user error, and it should be visible from the same command.
  const bundled = BUNDLED_SKILLS.flatMap((s) => validateSkill(s));
  lines.push('');
  if (bundled.length === 0) {
    lines.push(`  ${BUNDLED_SKILLS.length} bundled skills: all valid`);
  } else {
    lines.push(`  ${bundled.length} bundled skill problem(s) — please report this:`);
    for (const issue of bundled) lines.push(`      ${issue.skill}: ${issue.message}`);
  }

  if (load.issues.length === 0) {
    lines.push('');
    lines.push('  No problems found in user or project skills.');
  }
  return lines.join('\n');
}

function severityRank(issue: SkillIssue): number {
  return issue.severity === 'error' ? 0 : 1;
}
