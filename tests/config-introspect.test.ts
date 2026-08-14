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
    expect(paths).toContain('openaiCompatible.model');
    expect(paths).toContain('bots.telegram.allowedUserIds');
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
    expect(describeField('openaiCompatible.modelTimeoutMs')).toMatchObject({
      kind: 'number',
      min: 10000,
      max: 1800000,
      integer: true,
      default: 300000,
    });
  });

  it('flags url-formatted strings', () => {
    expect(describeField('openaiCompatible.baseUrl')).toMatchObject({
      kind: 'string',
      format: 'url',
    });
    expect(describeField('openaiCompatible.model')?.format).toBeUndefined();
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
    expect(describeField('openaiCompatible.baseUrl')?.label).toBe('Base URL');
    expect(describeField('bots.telegram.allowedUserIds')?.label).toBe('Allowed user IDs');
    expect(describeField('bots.telegram.streamThrottleMs')?.label).toBe('Stream throttle (ms)');
  });

  it('surfaces schema descriptions as help text', () => {
    expect(describeField('openaiCompatible.model')?.description).toMatch(/\/v1\/models/);
  });

  it('groups fields in declaration order', () => {
    expect(settingsByGroup().map((g) => g.group)).toEqual([
      'provider',
      'openaiCompatible',
      'anthropic',
      'bots',
      'daemon',
      'web',
      'stt',
      'permissions',
      'sandbox',
      'vision',
      'outputStyle',
    ]);
  });
});

describe('per-field validation', () => {
  it('accepts values inside the schema bounds', () => {
    expect(validateField('openaiCompatible.contextWindow', 8192)).toEqual({ ok: true });
    expect(validateField('provider', 'anthropic')).toEqual({ ok: true });
    expect(validateField('bots.telegram.allowedUserIds', [1, 2])).toEqual({ ok: true });
  });

  it('rejects out-of-range numbers with the schema message', () => {
    const result = validateField('bots.telegram.streamThrottleMs', 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/greater than or equal to 250/);
  });

  it('rejects values of the wrong type', () => {
    expect(validateField('stt.enabled', 'yes').ok).toBe(false);
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
    expect(validateField('openaiCompatible.baseUrl', 'not a url').ok).toBe(false);
    expect(validateField('openaiCompatible.baseUrl', 'http://localhost:1234')).toEqual({
      ok: true,
    });
  });
});
