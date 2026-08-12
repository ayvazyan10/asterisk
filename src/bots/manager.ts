// Bot manager — given the loaded config + secrets, instantiates the enabled
// adapters and gives the daemon one start/stop surface.

import type { LoadedConfig } from '../config/load.ts';
import type { BotAdapter, Handler } from './adapter.ts';
import { createTelegramAdapter } from './telegram/index.ts';

export interface BotManager {
  start(handler: Handler): Promise<string[]>;
  stop(): Promise<void>;
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
  };
}
