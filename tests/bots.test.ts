import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { createBotManager } from '../src/bots/manager.ts';
import { createWhatsappMetaCloudAdapter } from '../src/bots/whatsapp/meta-cloud.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';

type ConfigInput = z.input<typeof ConfigSchema>;

function loadedConfig(overrides: ConfigInput = {}, secrets = {}): LoadedConfig {
  return {
    config: ConfigSchema.parse(overrides),
    secrets,
  };
}

describe('BotManager', () => {
  it('creates no adapters when nothing is enabled', async () => {
    const manager = createBotManager(loadedConfig());
    const started = await manager.start(async () => 'ok');
    expect(started).toEqual([]);
    await manager.stop();
  });

  it('refuses to start Telegram without a token', () => {
    expect(() =>
      createBotManager(
        loadedConfig({ bots: { telegram: { enabled: true, allowedUserIds: [1] } } }),
      ),
    ).toThrow(/ASTERISK_TELEGRAM_BOT_TOKEN/);
  });

  it('refuses to start meta-cloud without credentials', () => {
    expect(() =>
      createBotManager(
        loadedConfig({
          bots: {
            whatsapp: {
              enabled: true,
              transport: 'meta-cloud',
              metaCloud: {
                phoneNumberId: '123',
                businessAccountId: '456',
                webhookPath: '/whatsapp/webhook',
                webhookPort: 8787,
              },
            },
          },
        }),
      ),
    ).toThrow(/META_TOKEN/);
  });
});

async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve_) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve_(port));
    });
  });
}

describe('WhatsApp Meta Cloud adapter', () => {
  let port: number;
  let dir: string;

  beforeEach(async () => {
    port = await findFreePort();
    dir = await mkdtemp(join(tmpdir(), 'asterisk-meta-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers webhook verification with the challenge', async () => {
    const adapter = createWhatsappMetaCloudAdapter({
      accessToken: 'test-token',
      verifyToken: 'verify-me',
      phoneNumberId: 'pn-1',
      webhookPath: '/whatsapp/webhook',
      webhookPort: port,
    });
    await adapter.start(async () => 'unused');

    const url = new URL(`http://127.0.0.1:${port}/whatsapp/webhook`);
    url.searchParams.set('hub.mode', 'subscribe');
    url.searchParams.set('hub.verify_token', 'verify-me');
    url.searchParams.set('hub.challenge', 'abc123');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc123');

    await adapter.stop();
  });

  it('rejects webhook verification with the wrong token', async () => {
    const adapter = createWhatsappMetaCloudAdapter({
      accessToken: 'test-token',
      verifyToken: 'verify-me',
      phoneNumberId: 'pn-1',
      webhookPath: '/whatsapp/webhook',
      webhookPort: port,
    });
    await adapter.start(async () => 'unused');

    const url = new URL(`http://127.0.0.1:${port}/whatsapp/webhook`);
    url.searchParams.set('hub.mode', 'subscribe');
    url.searchParams.set('hub.verify_token', 'wrong');
    url.searchParams.set('hub.challenge', 'abc123');
    const res = await fetch(url);
    expect(res.status).toBe(403);

    await adapter.stop();
  });
});
