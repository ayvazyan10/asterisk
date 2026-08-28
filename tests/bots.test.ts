import { describe, expect, it, vi } from 'vitest';

import type { z } from 'zod';

import { asOutgoingMessage, inferAttachmentKind } from '../src/bots/adapter.ts';
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

  it('counts nothing from a transport that cannot withdraw prompts', async () => {
    // cancelApprovals is optional on BotAdapter, exactly like promptApproval:
    // a transport that never asks has nothing to withdraw. Telegram implements
    // it, so the absent arm is only reachable with the module swapped out —
    // and it must come back 0, not undefined and not NaN, or /stop would
    // report nonsense in its acknowledgement.
    vi.resetModules();
    vi.doMock('../src/bots/telegram/index.ts', () => ({
      createTelegramAdapter: () => ({
        name: 'telegram',
        async start(): Promise<void> {},
        async stop(): Promise<void> {},
      }),
    }));
    try {
      const { createBotManager: create } = await import('../src/bots/manager.ts');
      const manager = create(
        loadedConfig(
          { bots: { telegram: { enabled: true, allowedUserIds: [1] } } },
          { ASTERISK_TELEGRAM_BOT_TOKEN: 'tok' },
        ),
      );
      const cancelled = manager.cancelApprovals('11');
      expect(cancelled).toBe(0);
      expect(Number.isNaN(cancelled)).toBe(false);
    } finally {
      vi.doUnmock('../src/bots/telegram/index.ts');
      vi.resetModules();
    }
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

describe('asOutgoingMessage', () => {
  it('wraps a bare string reply', () => {
    expect(asOutgoingMessage('hi')).toEqual({ text: 'hi' });
  });

  it('passes a structured reply through untouched', () => {
    const msg = { text: 'here', attachments: [{ kind: 'image' as const, path: '/tmp/a.png' }] };
    expect(asOutgoingMessage(msg)).toBe(msg);
  });
});

describe('inferAttachmentKind', () => {
  it.each([
    ['/tmp/shot.png', 'image'],
    ['/tmp/photo.jpeg', 'image'],
    ['/tmp/clip.mp4', 'video'],
    ['/tmp/clip.mkv', 'video'],
    ['/tmp/voice.ogg', 'audio'],
    ['/tmp/song.flac', 'audio'],
  ] as const)('maps %s to %s', (path, kind) => {
    expect(inferAttachmentKind(path)).toBe(kind);
  });

  it('ignores the case of the extension', () => {
    // Screenshots off a phone arrive as .PNG often enough to matter.
    expect(inferAttachmentKind('/tmp/SHOT.PNG')).toBe('image');
  });

  it('falls back to document for an extension it does not know', () => {
    expect(inferAttachmentKind('/tmp/report.pdf')).toBe('document');
  });

  it('falls back to document when the name has no extension', () => {
    expect(inferAttachmentKind('/tmp/LICENSE')).toBe('document');
  });

  it('reads the extension from the last dot, not the first', () => {
    expect(inferAttachmentKind('/tmp/archive.tar.mp3')).toBe('audio');
  });

  it('does not misread a dotted directory as an extension', () => {
    // The last dot here belongs to '.asterisk', not to the file. The lookup
    // then misses and lands on 'document' — the right answer, though it
    // arrives by the map missing rather than by the path being parsed.
    expect(inferAttachmentKind('/home/u/.asterisk/shot')).toBe('document');
  });
});
