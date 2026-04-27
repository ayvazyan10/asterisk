import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, saveConfig, saveSecrets } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';

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
    expect(config.bots.whatsapp.transport).toBe('meta-cloud');
    expect(secrets).toEqual({});
  });

  it('accepts streamMode + streamThrottleMs and rejects garbage', () => {
    const ok = ConfigSchema.parse({
      bots: { telegram: { streamMode: 'stream', streamThrottleMs: 1500 } },
    });
    expect(ok.bots.telegram.streamMode).toBe('stream');
    expect(ok.bots.telegram.streamThrottleMs).toBe(1500);

    expect(() =>
      ConfigSchema.parse({ bots: { telegram: { streamMode: 'real-time' } } }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({ bots: { telegram: { streamThrottleMs: 100 } } }),
    ).toThrow();
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

  it('saves secrets with chmod 600', async () => {
    saveSecrets({
      ANTHROPIC_API_KEY: 'sk-test',
      ASTERISK_TELEGRAM_BOT_TOKEN: 'bot-token',
    });
    const file = join(home, 'secrets.env');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('ANTHROPIC_API_KEY="sk-test"');
    expect(text).toContain('ASTERISK_TELEGRAM_BOT_TOKEN="bot-token"');

    const { stat } = await import('node:fs/promises');
    const s = await stat(file);
    // mode & 0o777 should be 0o600 (octal 384)
    expect((s.mode & 0o777).toString(8)).toBe('600');
  });

  it('loads secrets back from secrets.env', () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-back' });
    const { secrets } = loadConfig();
    expect(secrets.ANTHROPIC_API_KEY).toBe('sk-back');
  });

  it('rejects malformed config.json', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(home, 'config.json'), '{ not json');
    expect(() => loadConfig()).toThrow(/not valid JSON/);
  });
});
