import { describe, expect, it } from 'vitest';

import type { z } from 'zod';

import { createBotManager } from '../src/bots/manager.ts';
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

  it('ignores a stored whatsapp block left over from an older install', async () => {
    // ConfigSchema strips unknown keys, so a config carrying the removed
    // bots.whatsapp tree still parses — it just yields no adapter. Guards the
    // upgrade path: an existing install must not gain a bridge or throw.
    const manager = createBotManager(
      loadedConfig({ bots: { whatsapp: { enabled: true } } } as ConfigInput),
    );
    const started = await manager.start(async () => 'ok');
    expect(started).toEqual([]);
    await manager.stop();
  });
});
