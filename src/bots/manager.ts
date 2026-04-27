// Bot manager — given the loaded config + secrets, instantiates the enabled
// adapters and gives the daemon one start/stop surface.

import type { BotAdapter, Handler } from './adapter.ts';
import { createTelegramAdapter } from './telegram/index.ts';
import { createWhatsappMetaCloudAdapter } from './whatsapp/meta-cloud.ts';
import { createWhatsappWebJsAdapter } from './whatsapp/web-js.ts';
import type { LoadedConfig } from '../config/load.ts';

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
    adapters.push(createTelegramAdapter({ token, allowedUserIds: tg.allowedUserIds }));
  }

  const wa = loaded.config.bots.whatsapp;
  if (wa.enabled) {
    if (wa.transport === 'meta-cloud') {
      adapters.push(
        createWhatsappMetaCloudAdapter({
          accessToken: loaded.secrets.ASTERISK_WHATSAPP_META_TOKEN ?? '',
          verifyToken: loaded.secrets.ASTERISK_WHATSAPP_VERIFY_TOKEN ?? '',
          phoneNumberId: wa.metaCloud.phoneNumberId,
          webhookPath: wa.metaCloud.webhookPath,
          webhookPort: wa.metaCloud.webhookPort,
        }),
      );
    } else {
      adapters.push(createWhatsappWebJsAdapter({ sessionDir: wa.webJs.sessionDir }));
    }
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
