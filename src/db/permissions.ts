// Persistence for Bash rules the user answered "always allow" to.
//
// These are grants rather than settings, so they live in their own table:
// each one is revocable on its own and records where it came from. The rule
// text is the matcher understood by tools/bash-permissions.ts.

import type { SqliteDriver } from './driver.ts';

export interface GrantedRule {
  rule: string;
  grantedBy: string;
  createdAt: number;
}

interface RuleRow {
  rule: string;
  granted_by: string;
  created_at: number;
}

/** Every remembered rule, oldest first. */
export function listGrantedRules(db: SqliteDriver): GrantedRule[] {
  return db
    .all<RuleRow>(
      'SELECT rule, granted_by, created_at FROM command_permissions ORDER BY created_at',
    )
    .map((r) => ({ rule: r.rule, grantedBy: r.granted_by, createdAt: r.created_at }));
}

/** Just the rule strings, for handing to the policy evaluator. */
export function grantedAllowRules(db: SqliteDriver): string[] {
  return db
    .all<{ rule: string }>('SELECT rule FROM command_permissions ORDER BY rule')
    .map((r) => r.rule);
}

/**
 * Remembers rules. Re-granting an existing rule keeps the original timestamp
 * rather than refreshing it — the useful question is when access was first
 * given, not when it was last exercised.
 */
export function grantRules(db: SqliteDriver, rules: readonly string[], grantedBy = 'repl'): void {
  const cleaned = [...new Set(rules.map((r) => r.trim()).filter(Boolean))];
  if (cleaned.length === 0) return;
  db.transaction(() => {
    for (const rule of cleaned) {
      db.run(
        `INSERT INTO command_permissions (rule, granted_by, created_at) VALUES (?, ?, ?)
         ON CONFLICT(rule) DO NOTHING`,
        [rule, grantedBy, Date.now()],
      );
    }
  });
}

export function revokeRule(db: SqliteDriver, rule: string): void {
  db.run('DELETE FROM command_permissions WHERE rule = ?', [rule]);
}

export function revokeAllRules(db: SqliteDriver): void {
  db.run('DELETE FROM command_permissions');
}
