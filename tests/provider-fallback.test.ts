// Falling back to another backend when the first one cannot answer.
//
// The two interesting properties are both about NOT falling over: a rejected
// request must not be replayed against a second provider (it would fail there
// too, and the switch would hide the real error), and a reply that has already
// started streaming must not be restarted (the first half is already on the
// user's screen).

import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../src/providers/errors.ts';
import { createFallbackProvider } from '../src/providers/fallback.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/types/messages.ts';

function reply(text: string): ProviderResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function working(name: string, contextWindow?: number): Provider {
  return {
    name,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    async send() {
      return reply(name);
    },
  };
}

function failing(name: string, error: Error, contextWindow?: number): Provider {
  return {
    name,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    async send() {
      throw error;
    },
  };
}

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  system: '',
  messages: [],
  tools: [],
  ...over,
});

describe('createFallbackProvider', () => {
  it('returns the single provider unwrapped', () => {
    const only = working('solo');
    expect(createFallbackProvider([{ provider: only, label: 'solo' }])).toBe(only);
  });

  it('refuses an empty chain rather than failing later', () => {
    expect(() => createFallbackProvider([])).toThrow(/at least one/);
  });

  it('uses the first provider when it answers', async () => {
    const second = vi.fn();
    const chain = createFallbackProvider([
      { provider: working('first'), label: 'first' },
      { provider: { name: 'second', send: second }, label: 'second' },
    ]);

    const out = await chain.send(request());

    expect(out.content[0]).toMatchObject({ text: 'first' });
    expect(second).not.toHaveBeenCalled();
  });

  it.each([
    ['network', new ProviderError('network', 'connection refused')],
    ['server', new ProviderError('server', 'HTTP 502')],
    ['overloaded', new ProviderError('overloaded', 'overloaded')],
    ['rate-limit', new ProviderError('rate-limit', 'HTTP 429')],
    ['auth', new ProviderError('auth', 'HTTP 401')],
  ])('steps down the chain on %s', async (_kind, error) => {
    const chain = createFallbackProvider([
      { provider: failing('first', error), label: 'first' },
      { provider: working('second'), label: 'second' },
    ]);

    const out = await chain.send(request());
    expect(out.content[0]).toMatchObject({ text: 'second' });
  });

  it.each([
    ['bad-request', new ProviderError('bad-request', 'malformed tool schema')],
    ['context-overflow', new ProviderError('context-overflow', 'prompt too long')],
    ['aborted', new ProviderError('aborted', 'user cancelled')],
  ])('does not step down on %s', async (_kind, error) => {
    // These describe the request, not the backend. Retrying elsewhere burns a
    // second provider on the same input and hides the real error behind a
    // model switch.
    const second = vi.fn();
    const chain = createFallbackProvider([
      { provider: failing('first', error), label: 'first' },
      { provider: { name: 'second', send: second }, label: 'second' },
    ]);

    await expect(chain.send(request())).rejects.toThrow(error.message);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not step down once text has been streamed', async () => {
    // The first half of an answer is already on screen; a second attempt would
    // splice a whole new reply onto it.
    const second = vi.fn();
    const streamedThenFailed: Provider = {
      name: 'first',
      async send(req) {
        req.onText?.('half an ans');
        throw new ProviderError('network', 'connection lost mid-stream');
      },
    };
    const chain = createFallbackProvider([
      { provider: streamedThenFailed, label: 'first' },
      { provider: { name: 'second', send: second }, label: 'second' },
    ]);

    const seen: string[] = [];
    await expect(chain.send(request({ onText: (d) => seen.push(d) }))).rejects.toThrow(
      /mid-stream/,
    );
    expect(seen).toEqual(['half an ans']);
    expect(second).not.toHaveBeenCalled();
  });

  it('still fails over when streaming was requested but nothing arrived', async () => {
    const chain = createFallbackProvider([
      { provider: failing('first', new ProviderError('network', 'refused')), label: 'first' },
      { provider: working('second'), label: 'second' },
    ]);

    const out = await chain.send(request({ onText: () => undefined }));
    expect(out.content[0]).toMatchObject({ text: 'second' });
  });

  it('throws the last error when every link fails', async () => {
    const chain = createFallbackProvider([
      { provider: failing('first', new ProviderError('network', 'first refused')), label: 'a' },
      { provider: failing('second', new ProviderError('network', 'second refused')), label: 'b' },
    ]);

    await expect(chain.send(request())).rejects.toThrow(/second refused/);
  });

  it('reports each failover so the user knows which model answered', async () => {
    const onFailover = vi.fn();
    const chain = createFallbackProvider(
      [
        { provider: failing('first', new ProviderError('network', 'refused')), label: 'ollama' },
        { provider: working('second'), label: 'anthropic' },
      ],
      { onFailover },
    );

    await chain.send(request());
    expect(onFailover).toHaveBeenCalledWith(
      'ollama',
      'anthropic',
      expect.stringMatching(/refused/),
    );
  });

  it('advertises the smallest window in the chain', () => {
    // History is budgeted once and then sent to whichever link answers, so
    // budgeting against the largest and landing on the smallest overflows at
    // the worst possible moment.
    const chain = createFallbackProvider([
      { provider: working('big', 200_000), label: 'big' },
      { provider: working('small', 32_768), label: 'small' },
    ]);
    expect(chain.contextWindow).toBe(32_768);
  });

  it('reports no window when any link does not declare one', () => {
    const chain = createFallbackProvider([
      { provider: working('known', 200_000), label: 'known' },
      { provider: working('unknown'), label: 'unknown' },
    ]);
    expect(chain.contextWindow).toBeUndefined();
  });

  it('names every link so the transcript shows the chain', () => {
    const chain = createFallbackProvider([
      { provider: working('a'), label: 'ollama:qwen' },
      { provider: working('b'), label: 'anthropic:haiku' },
    ]);
    expect(chain.name).toBe('ollama:qwen → anthropic:haiku');
  });
});

describe('createProviderChain', () => {
  const load = async () => await import('../src/providers/factory.ts');
  const config = async (over: Record<string, unknown>) => {
    const { ConfigSchema } = await import('../src/config/schema.ts');
    return ConfigSchema.parse(over);
  };

  it('leaves the provider unwrapped when no fallback is configured', async () => {
    const { createProviderChain } = await load();
    const chosen = createProviderChain({ config: await config({}), secrets: {} });
    expect(chosen.provider.name).not.toContain('→');
  });

  it('ignores a fallback that names the primary', async () => {
    const { createProviderChain } = await load();
    const chosen = createProviderChain({
      config: await config({ provider: 'ollama', providerFallback: ['ollama'] }),
      secrets: {},
    });
    expect(chosen.provider.name).not.toContain('→');
  });

  it('drops an Anthropic fallback with no key instead of queuing a certain failure', async () => {
    const { createProviderChain } = await load();
    const chosen = createProviderChain({
      config: await config({ provider: 'ollama', providerFallback: ['anthropic'] }),
      secrets: {},
    });
    expect(chosen.provider.name).not.toContain('→');
  });

  it('builds a chain when the fallback is usable', async () => {
    const { createProviderChain } = await load();
    const chosen = createProviderChain({
      config: await config({ provider: 'ollama', providerFallback: ['openai-compatible'] }),
      secrets: {},
    });
    expect(chosen.provider.name).toContain('→');
  });
});
