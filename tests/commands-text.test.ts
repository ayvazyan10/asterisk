// The two leaf modules under src/commands: the shell/regex string helpers and
// the model-discovery calls the /model and /config flows depend on.
//
// Both are pure enough to pin exactly — the string helpers take no I/O at all,
// and the discovery calls have one seam (fetch) with four documented outcomes
// each. Everything else in src/commands sits on top of these, so a wrong
// answer here shows up as a mis-quoted shell command or an empty model picker.

import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ANTHROPIC_FALLBACK_MODELS,
  listAnthropicModels,
  parseProviderName,
} from '../src/commands/models.ts';
import { escapeRegex, quote, shellJoin, truncate } from '../src/commands/text.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replies with one JSON body, and records what was asked for. */
function respond(
  body: unknown,
  status = 200,
): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls };
}

function reject(message: string): void {
  globalThis.fetch = (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe('command text helpers', () => {
  it('truncate leaves short values alone and marks clipped ones', () => {
    expect(truncate('short', 10)).toBe('short');
    // Exactly at the limit is not "longer than", so it passes through whole.
    expect(truncate('0123456789', 10)).toBe('0123456789');
    expect(truncate('0123456789x', 10)).toBe('0123456789\n[truncated]');
  });

  it('quote survives a round trip through a real shell', () => {
    // The point of quote() is that the shell hands the value back byte for
    // byte. Asserting the quoted spelling would only restate the regex; this
    // asserts the property the callers rely on.
    const nasty = [
      "it's",
      'a b',
      '$HOME',
      '`id`',
      '"double"',
      'semi;colon && rm -rf /',
      'new\nline',
      "''",
    ];
    for (const value of nasty) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${quote(value)}`], {
        encoding: 'utf8',
      });
      expect(out).toBe(value);
    }
  });

  it('shellJoin quotes every argument, so a diff path cannot inject a flag', () => {
    const line = shellJoin(['diff', '--stat', '--', 'a file; rm -rf /']);
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' });
    expect(out.split('\n').filter(Boolean)).toEqual(['diff', '--stat', '--', 'a file; rm -rf /']);
  });

  it('escapeRegex makes a literal match itself and nothing else', () => {
    const literal = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(escapeRegex(literal)).test(literal)).toBe(true);
    expect(new RegExp(`^${escapeRegex('a.c')}$`).test('abc')).toBe(false);
    expect(new RegExp(`^${escapeRegex('a.c')}$`).test('a.c')).toBe(true);
  });

  it('escapeRegex leaves ordinary text untouched', () => {
    expect(escapeRegex('loadConfig')).toBe('loadConfig');
  });
});

describe('parseProviderName', () => {
  it('splits on the first colon, so model ids keep theirs', () => {
    expect(parseProviderName('openai-compatible:qwen3.5:9b-q8')).toEqual({
      kind: 'openai-compatible',
      model: 'qwen3.5:9b-q8',
    });
    expect(parseProviderName('anthropic:claude-opus-5')).toEqual({
      kind: 'anthropic',
      model: 'claude-opus-5',
    });
    expect(parseProviderName('openai-compatible:')).toEqual({
      kind: 'openai-compatible',
      model: '',
    });
  });

  it('rejects names without a colon or with an unknown backend', () => {
    expect(parseProviderName('ollama')).toBeNull();
    expect(parseProviderName('')).toBeNull();
    expect(parseProviderName('fake:model')).toBeNull();
    expect(parseProviderName('Ollama:model')).toBeNull();
  });
});

describe('listAnthropicModels', () => {
  it('does not call the API without a key, and answers from the offline list', async () => {
    const { calls } = respond({ data: [{ id: 'live-model' }] });
    expect(await listAnthropicModels('')).toEqual([...ANTHROPIC_FALLBACK_MODELS]);
    expect(calls).toHaveLength(0);
  });

  it('maps display_name onto the label and falls back to the id', async () => {
    const { calls } = respond({
      data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'claude-nameless-1' }],
    });
    expect(await listAnthropicModels('sk-test')).toEqual([
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-nameless-1', label: 'claude-nameless-1' },
    ]);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=100');
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.['x-api-key']).toBe('sk-test');
    expect(headers?.['anthropic-version']).toBe('2023-06-01');
  });

  it('falls back when the API errors, throws, or returns an empty list', async () => {
    respond({ data: [{ id: 'live' }] }, 401);
    expect(await listAnthropicModels('sk-bad')).toEqual([...ANTHROPIC_FALLBACK_MODELS]);

    reject('network down');
    expect(await listAnthropicModels('sk-test')).toEqual([...ANTHROPIC_FALLBACK_MODELS]);

    respond({ data: [] });
    expect(await listAnthropicModels('sk-test')).toEqual([...ANTHROPIC_FALLBACK_MODELS]);

    // A 200 that is not the documented shape at all.
    respond({ object: 'list' });
    expect(await listAnthropicModels('sk-test')).toEqual([...ANTHROPIC_FALLBACK_MODELS]);
  });

  it('offers no retired model ids', async () => {
    // Offering one only produces a 404 at the first request, which is why the
    // list is curated rather than historical.
    const ids = ANTHROPIC_FALLBACK_MODELS.map((m) => m.id);
    expect(ids).not.toContain('claude-3-5-sonnet-20241022');
    expect(ids).not.toContain('claude-3-7-sonnet-20250219');
    expect(ids).not.toContain('claude-3-5-haiku-20241022');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
