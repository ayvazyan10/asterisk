import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportConfigJson, loadConfig, saveConfig, saveSecrets } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';

describe('config schema and persistence', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevAnthropicKey: string | undefined;
  let prevTelegramToken: string | undefined;
  let prevWhatsappToken: string | undefined;
  let prevWhatsappVerify: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-cfg-'));
    prevHome = process.env['ASTERISK_HOME'];
    prevAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    prevTelegramToken = process.env['ASTERISK_TELEGRAM_BOT_TOKEN'];
    prevWhatsappToken = process.env['ASTERISK_WHATSAPP_META_TOKEN'];
    prevWhatsappVerify = process.env['ASTERISK_WHATSAPP_VERIFY_TOKEN'];
    process.env['ASTERISK_HOME'] = home;
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ASTERISK_TELEGRAM_BOT_TOKEN'];
    delete process.env['ASTERISK_WHATSAPP_META_TOKEN'];
    delete process.env['ASTERISK_WHATSAPP_VERIFY_TOKEN'];
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    if (prevAnthropicKey !== undefined) process.env['ANTHROPIC_API_KEY'] = prevAnthropicKey;
    if (prevTelegramToken !== undefined)
      process.env['ASTERISK_TELEGRAM_BOT_TOKEN'] = prevTelegramToken;
    if (prevWhatsappToken !== undefined)
      process.env['ASTERISK_WHATSAPP_META_TOKEN'] = prevWhatsappToken;
    if (prevWhatsappVerify !== undefined)
      process.env['ASTERISK_WHATSAPP_VERIFY_TOKEN'] = prevWhatsappVerify;
    await rm(home, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const { config, secrets } = loadConfig();
    expect(config.provider).toBe('ollama');
    expect(config.ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(config.bots.telegram.enabled).toBe(false);
    expect(config.bots.telegram.streamMode).toBe('final');
    expect(config.bots.telegram.streamThrottleMs).toBe(1000);
    expect(config.bots.telegram.parseMode).toBe('html');
    expect(config.bots.whatsapp.transport).toBe('meta-cloud');
    expect(secrets).toEqual({});
  });

  it('accepts streamMode + streamThrottleMs and rejects garbage', () => {
    const ok = ConfigSchema.parse({
      bots: { telegram: { streamMode: 'stream', streamThrottleMs: 1500 } },
    });
    expect(ok.bots.telegram.streamMode).toBe('stream');
    expect(ok.bots.telegram.streamThrottleMs).toBe(1500);

    expect(() => ConfigSchema.parse({ bots: { telegram: { streamMode: 'real-time' } } })).toThrow();
    expect(() => ConfigSchema.parse({ bots: { telegram: { streamThrottleMs: 100 } } })).toThrow();
  });

  it('round-trips a saved config', () => {
    const draft = ConfigSchema.parse({
      provider: 'anthropic',
      bots: {
        telegram: { enabled: true, allowedUserIds: [42] },
        whatsapp: { enabled: true, transport: 'web-js' },
      },
    });
    saveConfig(draft);

    const reloaded = loadConfig();
    expect(reloaded.config.provider).toBe('anthropic');
    expect(reloaded.config.bots.telegram.allowedUserIds).toEqual([42]);
    expect(reloaded.config.bots.whatsapp.transport).toBe('web-js');
  });

  it('stores secrets in the database, which is chmod 600', async () => {
    saveSecrets({
      ANTHROPIC_API_KEY: 'sk-test',
      ASTERISK_TELEGRAM_BOT_TOKEN: 'bot-token',
    });

    const { secrets } = loadConfig();
    expect(secrets.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(secrets.ASTERISK_TELEGRAM_BOT_TOKEN).toBe('bot-token');

    const { stat } = await import('node:fs/promises');
    const s = await stat(join(home, 'asterisk.db'));
    expect((s.mode & 0o777).toString(8)).toBe('600');
  });

  it('clears a secret when saved as empty', () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    saveSecrets({ ANTHROPIC_API_KEY: '' });
    expect(loadConfig().secrets.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('loads secrets back after a round trip', () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-back' });
    const { secrets } = loadConfig();
    expect(secrets.ANTHROPIC_API_KEY).toBe('sk-back');
  });

  it('imports a legacy config.json once and renames it aside', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ provider: 'anthropic', ollama: { model: 'legacy-model' } }),
    );
    await writeFile(join(home, 'secrets.env'), 'ANTHROPIC_API_KEY="sk-legacy"\n');

    const { config, secrets } = loadConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.ollama.model).toBe('legacy-model');
    expect(secrets.ANTHROPIC_API_KEY).toBe('sk-legacy');

    // The original is preserved under a .migrated suffix, and re-loading does
    // not re-import (which would clobber later edits).
    expect(await readFile(join(home, 'config.json.migrated'), 'utf8')).toContain('legacy-model');
    saveConfig(ConfigSchema.parse({ provider: 'ollama' }));
    expect(loadConfig().config.provider).toBe('ollama');
  });

  it('exports the stored config back to JSON without secrets', async () => {
    saveConfig(ConfigSchema.parse({ provider: 'anthropic' }));
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-secret' });

    const target = exportConfigJson(join(home, 'export.json'));
    const text = await readFile(target, 'utf8');
    expect(JSON.parse(text).provider).toBe('anthropic');
    expect(text).not.toContain('sk-secret');
  });

  it('rejects malformed config.json', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(home, 'config.json'), '{ not json');
    expect(() => loadConfig()).toThrow(/not valid JSON/);
  });
});
