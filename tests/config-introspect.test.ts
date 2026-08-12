import { describe, expect, it } from 'vitest';

import {
  describeField,
  settingsByGroup,
  settingsRegistry,
  validateField,
} from '../src/config/introspect.ts';

describe('settings registry', () => {
  it('derives every scalar leaf of the schema', () => {
    const paths = settingsRegistry().map((f) => f.path);
    expect(paths).toContain('provider');
    expect(paths).toContain('ollama.model');
    expect(paths).toContain('bots.telegram.allowedUserIds');
    expect(paths).toContain('bots.whatsapp.metaCloud.webhookPort');
    expect(paths).toContain('web.port');
    expect(paths).toContain('outputStyle');
  });

  it('excludes the collection-backed keys', () => {
    const paths = settingsRegistry().map((f) => f.path);
    expect(paths.some((p) => p.startsWith('mcpServers'))).toBe(false);
    expect(paths.some((p) => p.startsWith('hooks'))).toBe(false);
  });

  it('never emits an unknown widget kind', () => {
    expect(settingsRegistry().filter((f) => f.kind === 'unknown')).toEqual([]);
  });

  it('carries enum options', () => {
    expect(describeField('bots.telegram.streamMode')).toMatchObject({
      kind: 'enum',
      options: ['final', 'status', 'stream'],
      default: 'final',
    });
  });

  it('carries numeric bounds and integer-ness', () => {
    expect(describeField('ollama.modelTimeoutMs')).toMatchObject({
      kind: 'number',
      min: 10000,
      max: 1800000,
      integer: true,
      default: 300000,
    });
  });

  it('flags url-formatted strings', () => {
    expect(describeField('ollama.baseUrl')).toMatchObject({ kind: 'string', format: 'url' });
    expect(describeField('ollama.model')?.format).toBeUndefined();
  });

  it('detects typed arrays', () => {
    expect(describeField('bots.telegram.allowedUserIds')).toMatchObject({
      kind: 'number-array',
      default: [],
    });
  });

  it('humanises labels and assigns groups', () => {
    expect(describeField('bots.telegram.streamThrottleMs')).toMatchObject({
      label: 'Stream throttle (ms)',
      group: 'bots',
    });
  });

  it('keeps acronyms uppercase in labels', () => {
    expect(describeField('ollama.baseUrl')?.label).toBe('Base URL');
    expect(describeField('bots.telegram.allowedUserIds')?.label).toBe('Allowed user IDs');
    expect(describeField('bots.whatsapp.metaCloud.phoneNumberId')?.label).toBe('Phone number ID');
  });

  it('surfaces schema descriptions as help text', () => {
    expect(describeField('ollama.think')?.description).toMatch(/reasoning/i);
  });

  it('groups fields in declaration order', () => {
    expect(settingsByGroup().map((g) => g.group)).toEqual([
      'provider',
      'ollama',
      'openaiCompatible',
      'anthropic',
      'bots',
      'daemon',
      'web',
      'permissions',
      'outputStyle',
    ]);
  });
});

describe('per-field validation', () => {
  it('accepts values inside the schema bounds', () => {
    expect(validateField('ollama.contextWindow', 8192)).toEqual({ ok: true });
    expect(validateField('provider', 'anthropic')).toEqual({ ok: true });
    expect(validateField('bots.telegram.allowedUserIds', [1, 2])).toEqual({ ok: true });
  });

  it('rejects out-of-range numbers with the schema message', () => {
    const result = validateField('bots.telegram.streamThrottleMs', 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/greater than or equal to 250/);
  });

  it('rejects values of the wrong type', () => {
    expect(validateField('ollama.think', 'yes').ok).toBe(false);
    expect(validateField('bots.telegram.allowedUserIds', ['a']).ok).toBe(false);
  });

  it('rejects unknown paths instead of silently accepting them', () => {
    expect(validateField('does.not.exist', 1)).toEqual({
      ok: false,
      error: 'no such setting: does.not.exist',
    });
    expect(validateField('ollama.model.nested', 1).ok).toBe(false);
  });

  it('rejects a malformed url for url-formatted fields', () => {
    expect(validateField('ollama.baseUrl', 'not a url').ok).toBe(false);
    expect(validateField('ollama.baseUrl', 'http://localhost:1234')).toEqual({ ok: true });
  });
});
