// Wires the Bash permission policy to its inputs: the stored config, the
// rules the user has remembered, and whatever UI can show a prompt.
//
// Kept separate from bash-permissions.ts so the policy itself stays pure and
// testable without a database, and separate from bash.ts so the tool body
// stays about running commands.

import { currentSession } from '../agent/context.ts';
import { loadConfig } from '../config/load.ts';
import { getDb } from '../db/index.ts';
import { grantRules, grantedAllowRules } from '../db/permissions.ts';
import { requestApproval } from './approval.ts';
import { type PolicyInput, evaluateCommand, suggestRules } from './bash-permissions.ts';

export interface GateResult {
  allowed: boolean;
  /** Populated when refused — written for the model, which has to decide what
   *  to do next, as much as for the user reading the transcript. */
  message: string;
}

const ALLOWED: GateResult = { allowed: true, message: '' };

/** Falls back to the schema's own defaults, which are the safe end of every
 *  knob, if the config or the database cannot be read. */
const FALLBACK = {
  mode: 'ask',
  allow: [],
  deny: [],
  headless: 'deny',
  timeoutSeconds: 90,
} as const;

interface Resolved extends PolicyInput {
  headless: 'deny' | 'allow';
  timeoutMs: number;
}

function resolvePolicy(): Resolved {
  // A session-scoped override — set only by `asterisk run --allow-tools`
  // (src/run/cli.ts) — beats the stored config's `headless` for calls made
  // inside that session, and only that session. Nothing else in the process
  // (a concurrent REPL, another session's turn) sees it: AsyncLocalStorage
  // scopes it the same way it already scopes tasks, plan mode and worktrees.
  const override = currentSession().headlessOverride;

  try {
    const { config } = loadConfig();
    const p = config.permissions;
    const granted = grantedAllowRules(getDb());
    return {
      mode: p.mode,
      allow: [...p.allow, ...granted],
      deny: p.deny,
      headless: override ?? p.headless,
      timeoutMs: p.timeoutSeconds * 1000,
    };
  } catch {
    return {
      mode: FALLBACK.mode,
      allow: [...FALLBACK.allow],
      deny: [...FALLBACK.deny],
      headless: override ?? FALLBACK.headless,
      timeoutMs: FALLBACK.timeoutSeconds * 1000,
    };
  }
}

/**
 * Decides whether `command` may run, prompting a human when the policy cannot
 * settle it alone. Never throws: a failure to reach the approver is a refusal,
 * not an exception, so the tool reports it as a normal error result.
 */
export async function authoriseBashCommand(
  command: string,
  signal?: AbortSignal,
): Promise<GateResult> {
  const policy = resolvePolicy();
  const decision = evaluateCommand(command, policy);

  if (decision.action === 'allow') return ALLOWED;

  if (decision.action === 'deny') {
    return { allowed: false, message: `refused: ${decision.reason}.` };
  }

  const rules = suggestRules(decision.segments);
  const approval = await requestApproval(
    { command, reason: decision.reason, rules },
    {
      timeoutMs: policy.timeoutMs,
      headless: policy.headless,
      ...(signal ? { signal } : {}),
    },
  );

  if (approval.outcome === 'allow-always') {
    try {
      grantRules(getDb(), rules);
    } catch {
      // The command was approved for this call either way; failing to persist
      // the grant costs the user another prompt next time, nothing worse.
    }
    return ALLOWED;
  }

  if (approval.outcome === 'allow-once') return ALLOWED;

  return { allowed: false, message: refusalMessage(decision.reason, rules, approval.automatic) };
}

function refusalMessage(reason: string, rules: readonly string[], automatic?: boolean): string {
  const quoted = rules.map((r) => `"${r}"`).join(', ');
  if (!automatic) {
    return `refused by the user: ${reason}. Do not retry this command; ask what to do instead.`;
  }
  return [
    `refused: ${reason}, and no one was available to approve it`,
    '(unattended run — the daemon and the bot bridges have no prompt).',
    rules.length > 0
      ? `To allow this, the user can add ${quoted} to permissions.allow — via \`asterisk web\` → Settings, or \`/permissions allow <rule>\` in the REPL.`
      : '',
    'Setting permissions.headless to "allow" removes the boundary for every unattended run.',
  ]
    .filter(Boolean)
    .join(' ');
}
