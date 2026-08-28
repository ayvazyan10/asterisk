// Bot manager — given the loaded config + secrets, instantiates the enabled
// adapters and gives the daemon one start/stop surface.

import type { LoadedConfig } from '../config/load.ts';
import type { ApprovalOutcome } from '../tools/approval.ts';
import type { ApprovalPrompt, BotAdapter, Handler } from './adapter.ts';
import { createTelegramAdapter } from './telegram/index.ts';

export interface BotManager {
  start(handler: Handler): Promise<string[]>;
  stop(): Promise<void>;
  /** True when at least one transport can put a permission prompt in a chat. */
  canPromptApproval(): boolean;
  /** Asks the chat to decide. Denies if no transport can ask. */
  promptApproval(chatId: string, prompt: ApprovalPrompt): Promise<ApprovalOutcome>;
  /** Withdraws one chat's open permission questions; returns how many. */
  cancelApprovals(chatId: string): number;
}

export function createBotManager(loaded: LoadedConfig): BotManager {
  const adapters: BotAdapter[] = [];

  const tg = loaded.config.bots.telegram;
  if (tg.enabled) {
    const token = loaded.secrets.ASTERISK_TELEGRAM_BOT_TOKEN ?? '';
    if (!token) {
      throw new Error('Telegram bot enabled but ASTERISK_TELEGRAM_BOT_TOKEN is not set');
    }
    adapters.push(
      createTelegramAdapter({
        token,
        allowedUserIds: tg.allowedUserIds,
        streamMode: tg.streamMode,
        streamThrottleMs: tg.streamThrottleMs,
        parseMode: tg.parseMode,
      }),
    );
  }

  return {
    async start(handler: Handler): Promise<string[]> {
      const started: string[] = [];
      for (const a of adapters) {
        await a.start(handler);
        started.push(a.name);
      }
      return started;
    },
    async stop(): Promise<void> {
      for (const a of adapters) {
        await a.stop().catch(() => {});
      }
    },
    canPromptApproval(): boolean {
      return adapters.some((a) => typeof a.promptApproval === 'function');
    },
    async promptApproval(chatId: string, prompt: ApprovalPrompt): Promise<ApprovalOutcome> {
      // One transport today. When there are two, the chat id is what tells
      // them apart, so the first that accepts it answers.
      for (const a of adapters) {
        if (!a.promptApproval) continue;
        try {
          return await a.promptApproval(chatId, prompt);
        } catch {
          // A transport that fails to ask has not obtained consent.
          return 'deny';
        }
      }
      return 'deny';
    },
    cancelApprovals(chatId: string): number {
      // Every transport is asked, because the chat id is what tells them
      // apart and only the one that owns it has anything to withdraw.
      let cancelled = 0;
      for (const a of adapters) cancelled += a.cancelApprovals?.(chatId) ?? 0;
      return cancelled;
    },
  };
}
