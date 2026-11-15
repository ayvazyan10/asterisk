// Shared tool consent: stored policy, remembered grants and the approval UI.
// Bash keeps command-level analysis; the registry calls authoriseTool for
// protected file access, network sends and MCP calls, including from RunCode.
//
// Command analysis stays testable without a database, and tool bodies stay
// about their own work rather than how to reach a person.

import { currentSession } from '../agent/context.ts';
import { loadConfig } from '../config/load.ts';
import { getDb } from '../db/index.ts';
import { grantRules, grantedAllowRules } from '../db/permissions.ts';
import { requestApproval } from './approval.ts';
import {
  ASTERISK_HOME_READ_RULE,
  type PolicyInput,
  evaluateCommand,
  suggestRules,
} from './bash-permissions.ts';
import { checkOutboundUrl } from './ssrf-guard.ts';
import type { Tool } from './types.ts';
import { isAsteriskHomePath, protectedWriteReason } from './write-policy.ts';

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

  const rules = suggestRules(decision.segments, policy.allow);
  return approve(command, decision.reason, rules, policy, signal);
}

/** Non-Bash checks run once, in the registry's execution wrapper. */
export async function authoriseTool(
  tool: Tool,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GateResult> {
  let reason: string | null = null;
  const rules: string[] = [];
  const path = typeof input['path'] === 'string' ? input['path'] : '';

  if ((tool.name === 'Write' || tool.name === 'Edit') && path) {
    reason = protectedWriteReason(path);
  } else if (tool.name === 'Read' && path && isAsteriskHomePath(path)) {
    rules.push(ASTERISK_HOME_READ_RULE);
    reason = 'the Asterisk home can contain secrets';
  } else if (tool.name === 'RemoteTrigger' || tool.name === 'PushNotification') {
    const url =
      tool.name === 'PushNotification'
        ? (typeof input['url'] === 'string' && input['url'].trim()) ||
          process.env['ASTERISK_NOTIFY_URL'] ||
          ''
        : typeof input['url'] === 'string'
          ? input['url']
          : '';
    const check = checkOutboundUrl(url);
    if (check.reason) return { allowed: false, message: `refused: ${check.reason}` };
    // Freeze the configured webhook too: execution must use the URL approved
    // here even if its environment setting changes while the prompt is open.
    input['url'] = url;
    const origin = new URL(url).origin;
    rules.push(`network:${origin}`);
    reason = `sends data to ${origin}`;
  } else if (tool.permissionRule) {
    rules.push(tool.permissionRule);
    reason = `calls MCP tool ${tool.permissionRule.slice('mcp:'.length)}`;
  }

  if (!reason) return ALLOWED;
  const policy = resolvePolicy();
  if (policy.mode === 'unrestricted') return ALLOWED;
  if (rules.some((rule) => policy.deny.includes(rule))) {
    return { allowed: false, message: `refused: ${reason} matches a deny rule.` };
  }
  if (rules.length > 0 && rules.every((rule) => policy.allow.includes(rule))) return ALLOWED;
  if (policy.mode === 'allowlist') {
    return { allowed: false, message: `refused: ${reason} (permissions.mode is allowlist).` };
  }
  // Protected writes deliberately have no persistent grant.
  return approve(`${tool.name} ${JSON.stringify(input)}`, reason, rules, policy, signal);
}

async function approve(
  command: string,
  reason: string,
  rules: readonly string[],
  policy: Resolved,
  signal?: AbortSignal,
): Promise<GateResult> {
  const approval = await requestApproval(
    { command, reason, rules },
    {
      timeoutMs: policy.timeoutMs,
      headless: policy.headless,
      ...(signal ? { signal } : {}),
    },
  );

  if (approval.outcome === 'allow-always') {
    try {
      grantRules(getDb(), rules, currentSession().id);
    } catch {
      // The command was approved for this call either way; failing to persist
      // the grant costs the user another prompt next time, nothing worse.
    }
    return ALLOWED;
  }

  if (approval.outcome === 'allow-once') return ALLOWED;

  return { allowed: false, message: refusalMessage(reason, rules, approval.automatic) };
}

function refusalMessage(reason: string, rules: readonly string[], automatic?: boolean): string {
  const quoted = rules.map((r) => `"${r}"`).join(', ');
  if (!automatic) {
    return `refused by the user: ${reason}. Do not retry this action; ask what to do instead.`;
  }
  return [
    `refused: ${reason}, and no one was available to approve it`,
    '(unattended run or approval timed out).',
    rules.length > 0
      ? `To allow this, the user can add ${quoted} to permissions.allow — via \`asterisk web\` → Settings, or \`/permissions allow <rule>\` in the REPL.`
      : '',
    'Setting permissions.headless to "allow" removes the boundary for every unattended run.',
  ]
    .filter(Boolean)
    .join(' ');
}
