// `/permissions` — inspect and edit the Bash permission boundary.
//
// Grants made by answering "allow always" at a prompt land in the database,
// where nothing else would show them. A security control the user cannot
// enumerate or revoke is worse than none, so this command exists to make the
// effective policy visible in one place.

import { loadConfig, saveConfig } from '../config/load.ts';
import { getDb } from '../db/index.ts';
import { listGrantedRules, revokeAllRules, revokeRule } from '../db/permissions.ts';
import type { ListSpec } from '../repl/forms/types.ts';
import { defaultAllowRules } from '../tools/bash-permissions.ts';
import type { SlashCommand } from './registry.ts';

function summary(): string {
  const { config } = loadConfig();
  const p = config.permissions;
  const granted = listGrantedRules(getDb());

  const lines = [
    `Permissions · Bash · mode ${p.mode} · unattended runs ${p.headless}`,
    '',
    'A consent boundary, not a sandbox — an approved command runs with your',
    'full privileges. What it buys is that nothing runs unreviewed.',
    '',
    `Built-in read-only rules   ${defaultAllowRules().length}  (/permissions builtin)`,
  ];

  lines.push('', `From config · permissions.allow   ${p.allow.length}`);
  for (const rule of p.allow) lines.push(`  allow  ${rule}`);
  lines.push(`From config · permissions.deny    ${p.deny.length}`);
  for (const rule of p.deny) lines.push(`  deny   ${rule}`);

  lines.push('', `Remembered from "allow always"    ${granted.length}`);
  if (granted.length === 0) {
    lines.push('  (none yet — they appear here once you answer "Allow always" at a prompt)');
  }
  for (const g of granted) {
    const when = new Date(g.createdAt).toISOString().slice(0, 10);
    lines.push(`  ${when}  ${g.rule.padEnd(30)} granted via ${g.grantedBy}`);
  }

  lines.push(
    '',
    'Usage: /permissions allow <rule> · /permissions deny <rule> ·',
    '       /permissions revoke [rule] · /permissions builtin',
  );
  return lines.join('\n');
}

function listBuiltins(): string {
  const rules = defaultAllowRules();
  return [
    `Built-in read-only rules · ${rules.length}`,
    '',
    'These run without asking. Everything else prompts once.',
    '',
    ...rules.map((r) => `  ${r}`),
    '',
    'Rules match positionally against the command, so "git log" covers',
    '"git log --oneline" but not "git push". Chained commands are judged one',
    'segment at a time — if any segment needs approval, the whole line does.',
  ].join('\n');
}

/**
 * Strips one layer of surrounding quotes.
 *
 * The documented form is `/permissions allow "npm test"` — quoted, because the
 * rule contains a space — and the quotes were being stored as part of the rule.
 * `"npm test"` is then matched against the first word of the command and can
 * never hit, so the rule silently did nothing and the user kept being prompted
 * for the very command they had allowed.
 */
function unquote(rule: string): string {
  const trimmed = rule.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.length > 1 && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Adds a rule to `permissions.allow` or `permissions.deny` in config. */
function addConfigRule(list: 'allow' | 'deny', rule: string): string {
  const trimmed = unquote(rule);
  if (!trimmed) return `usage: /permissions ${list} <rule>`;

  const { config } = loadConfig();
  const current = config.permissions[list];
  if (current.includes(trimmed)) return `"${trimmed}" is already in permissions.${list}.`;

  saveConfig({
    ...config,
    permissions: { ...config.permissions, [list]: [...current, trimmed] },
  });
  const note =
    list === 'deny'
      ? 'It is now refused outright, ahead of every allow rule.'
      : 'It now runs without asking.';
  return `Added "${trimmed}" to permissions.${list}. ${note}`;
}

function revokePicker(): ListSpec | string {
  const granted = listGrantedRules(getDb());
  if (granted.length === 0) return 'Nothing to revoke — no rules have been remembered yet.';
  return {
    kind: 'list',
    title: 'Revoke a remembered rule',
    items: [
      ...granted.map((g) => ({
        value: g.rule,
        label: g.rule,
        description: `granted via ${g.grantedBy} on ${new Date(g.createdAt)
          .toISOString()
          .slice(0, 10)}`,
      })),
      { value: '*', label: 'Revoke all', description: `Forget all ${granted.length} rules.` },
    ],
    onPick: (value: string) => {
      if (value === '*') {
        revokeAllRules(getDb());
        return 'Revoked every remembered rule. Those commands will prompt again.';
      }
      revokeRule(getDb(), value);
      return `Revoked "${value}". It will prompt again next time.`;
    },
  };
}

export const permissionsCommand: SlashCommand = {
  name: '/permissions',
  description: 'Inspect and edit what the Bash tool may run without asking',
  usage: '/permissions [allow <rule>|deny <rule>|revoke [rule]|builtin]',
  execute(_ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) return summary();

    const [verb, ...rest] = trimmed.split(/\s+/);
    // Quoting is how a rule with a space is written; the quotes are syntax,
    // not part of the rule.
    const rule = unquote(rest.join(' '));

    if (verb === 'builtin' || verb === 'builtins') return listBuiltins();
    if (verb === 'allow') return addConfigRule('allow', rule);
    if (verb === 'deny') return addConfigRule('deny', rule);
    if (verb === 'revoke') {
      if (!rule) return revokePicker();
      if (rule === '*') {
        revokeAllRules(getDb());
        return 'Revoked every remembered rule.';
      }
      const known = listGrantedRules(getDb()).some((g) => g.rule === rule);
      if (!known) return `"${rule}" is not a remembered rule. Run /permissions to see the list.`;
      revokeRule(getDb(), rule);
      return `Revoked "${rule}". It will prompt again next time.`;
    }
    return `unknown /permissions verb: ${verb}`;
  },
};
