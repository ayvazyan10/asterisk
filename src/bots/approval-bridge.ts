// Routes permission requests raised by a bot turn back into that chat.
//
// The daemon used to be structurally unattended: `permissions.mode` defaults to
// `ask`, nothing in a bot turn could ask, and so every command outside the
// allowlist came back as the headless refusal — which reads to the user as
// "your policy blocked it" rather than "you were never asked".
//
// Sessions are `bot:<chatId>` (see the daemon's turn handler), so the chat id
// is the routing key. Scheduled runs are `scheduled:<source>` and stay
// unattended on purpose: a cron job firing at 04:00 has nobody to prompt.

import { type ApprovalRequest, onApprovalRequest, resolveApproval } from '../tools/approval.ts';
import type { ApprovalPrompt } from './adapter.ts';
import type { BotManager } from './manager.ts';

export const BOT_SESSION_PREFIX = 'bot:';

export interface ApprovalBridgeOptions {
  manager: Pick<BotManager, 'canPromptApproval' | 'promptApproval'>;
  /** Whether chat approvals are switched on — read per request, not cached,
   *  so turning the setting off takes effect without a daemon restart. */
  enabled: () => boolean;
  /** How long the transport has to come back with an answer. */
  timeoutMs: () => number;
  log?: (fields: Record<string, unknown>, msg: string) => void;
}

/** Subscribes the bridge. Returns an unsubscribe function. */
export function attachChatApprovals(opts: ApprovalBridgeOptions): () => void {
  const { manager, enabled, timeoutMs } = opts;
  const log = opts.log ?? ((): void => undefined);

  const handle = (req: ApprovalRequest): void => {
    const chatId = req.sessionId.slice(BOT_SESSION_PREFIX.length);
    log({ chatId, command: req.command.slice(0, 200) }, 'approval requested');
    const prompt: ApprovalPrompt = {
      command: req.command,
      reason: req.reason,
      rules: req.rules,
      timeoutMs: timeoutMs(),
    };
    void manager
      .promptApproval(chatId, prompt)
      .then((outcome) => {
        log({ chatId, outcome }, 'approval answered');
        resolveApproval(req.id, outcome);
      })
      .catch((err: unknown) => {
        log({ chatId, err }, 'approval prompt failed');
        resolveApproval(req.id, 'deny');
      });
  };

  return onApprovalRequest(handle, {
    accepts: (sessionId) => {
      if (!sessionId.startsWith(BOT_SESSION_PREFIX)) return false;
      try {
        return enabled() && manager.canPromptApproval();
      } catch {
        // An unreadable config is not consent: report that nobody can answer,
        // and the policy falls back to permissions.headless.
        return false;
      }
    },
  });
}
