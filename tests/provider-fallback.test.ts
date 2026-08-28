// Falling back to another backend when the first one cannot answer.
//
// The two interesting properties are both about NOT falling over: a rejected
// request must not be replayed against a second provider (it would fail there
// too, and the switch would hide the real error), and a reply that has already
// started streaming must not be restarted (the first half is already on the
// user's screen).

import { afterEach, describe, expect, it, vi } from 'vitest';

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
        { provider: failing('first', new ProviderError('network', 'refused')), label: 'local' },
        { provider: working('second'), label: 'anthropic' },
      ],
      { onFailover },
    );

    await chain.send(request());
    expect(onFailover).toHaveBeenCalledWith('local', 'anthropic', expect.stringMatching(/refused/));
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
    // Rewritten: the chain used to join the labels, which factory.ts fills in
    // from `provider.name` at construction time. That snapshot is what made
    // /status say `openai-compatible:auto` for the rest of the run — see the
    // lazy-getter tests below. The name now comes from the providers
    // themselves; `label` stays what a failover is reported under.
    const chain = createFallbackProvider([
      { provider: working('openai-compatible:qwen'), label: 'local' },
      { provider: working('anthropic:haiku'), label: 'anthropic' },
    ]);
    expect(chain.name).toBe('openai-compatible:qwen → anthropic:haiku');
  });
});

describe('a chain over a provider that learns what it is', () => {
  // openai-compatible does not know its model or its window until it has
  // spoken to the server, so it exposes both as getters. The chain used to
  // read them once while it was being built — before any request had been
  // made — and keep the answer forever: name pinned at `:auto`, window pinned
  // at undefined, and compaction therefore budgeting 76 800 tokens of history
  // against a window of 8 192. That is the exact failure model-detect.ts was
  // written to end, coming back the moment a fallback was configured.

  /** A provider shaped like openai-compatible: both facts arrive on send(). */
  function lazy(id: string, window: number): Provider {
    let detected: { id: string; window: number } | null = null;
    return {
      get name(): string {
        return `openai-compatible:${detected?.id ?? 'auto'}`;
      },
      get contextWindow(): number | undefined {
        return detected?.window;
      },
      async send() {
        detected = { id, window };
        return reply(id);
      },
    };
  }

  it('reports the real window once the first request has been made', async () => {
    const chain = createFallbackProvider([
      { provider: lazy('qwen3.5:9b', 8_192), label: 'local' },
      { provider: working('anthropic', 200_000), label: 'anthropic' },
    ]);

    expect(chain.contextWindow).toBeUndefined(); // nothing detected yet
    await chain.send(request());
    expect(chain.contextWindow).toBe(8_192);
  });

  it('reports the real model name once the first request has been made', async () => {
    const chain = createFallbackProvider([
      { provider: lazy('qwen3.5:9b', 8_192), label: 'local' },
      { provider: working('anthropic:haiku', 200_000), label: 'anthropic' },
    ]);

    expect(chain.name).toBe('openai-compatible:auto → anthropic:haiku');
    await chain.send(request());
    expect(chain.name).toBe('openai-compatible:qwen3.5:9b → anthropic:haiku');
  });

  it('budgets compaction against the server window, not the 128k default', async () => {
    // End to end against the real provider: a server reporting meta.n_ctx.
    const { clearDetectedModels } = await import('../src/providers/model-detect.ts');
    const { createOpenAiCompatibleProvider } = await import(
      '../src/providers/openai-compatible.ts'
    );
    const { compactionThreshold, DEFAULT_CONTEXT_WINDOW } = await import(
      '../src/agent/compaction.ts'
    );

    const baseUrl = 'http://stub.invalid:9/v1';
    const realFetch = globalThis.fetch;
    clearDetectedModels(baseUrl);
    globalThis.fetch = (async (url: string) =>
      new Response(
        String(url).endsWith('/models')
          ? JSON.stringify({ data: [{ id: 'qwen3.5:9b', meta: { n_ctx: 8192 } }] })
          : JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    try {
      const local = createOpenAiCompatibleProvider({ baseUrl, model: '' });
      const chain = createFallbackProvider([
        { provider: local, label: 'local' },
        { provider: working('anthropic', 200_000), label: 'anthropic' },
      ]);

      await chain.send(request());

      expect(local.contextWindow).toBe(8_192);
      expect(chain.contextWindow).toBe(8_192);
      expect(compactionThreshold(chain.contextWindow)).toBeLessThan(
        compactionThreshold(DEFAULT_CONTEXT_WINDOW),
      );
    } finally {
      globalThis.fetch = realFetch;
      clearDetectedModels(baseUrl);
    }
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
      config: await config({
        provider: 'openai-compatible',
        providerFallback: ['openai-compatible'],
      }),
      secrets: {},
    });
    expect(chosen.provider.name).not.toContain('→');
  });

  it('drops an Anthropic fallback with no key instead of queuing a certain failure', async () => {
    const { createProviderChain } = await load();
    const chosen = createProviderChain({
      config: await config({ provider: 'openai-compatible', providerFallback: ['anthropic'] }),
      secrets: {},
    });
    expect(chosen.provider.name).not.toContain('→');
  });

  it('builds a chain when the fallback is usable', async () => {
    const { createProviderChain } = await load();
    const chosen = createProviderChain({
      config: await config({ provider: 'openai-compatible', providerFallback: ['anthropic'] }),
      // With a key the Anthropic link can actually answer, so it stays.
      secrets: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    expect(chosen.provider.name).toContain('→');
  });
});

describe('a local server that goes quiet', () => {
  // The scenario the chain exists for, spelled out end to end: the laptop is
  // configured local-first, llama-server takes the request and stops
  // answering, and an Anthropic key is sitting right there. Until the
  // cancellation classifier learnt to ask WHO cancelled, the timeout came out
  // as the user's own abort — no retry, no step down, and the turn died on the
  // dead backend with the second provider never called.
  const realFetch = globalThis.fetch;
  const baseUrl = 'http://stalled.invalid:9/v1';

  afterEach(async () => {
    globalThis.fetch = realFetch;
    const { clearDetectedModels } = await import('../src/providers/model-detect.ts');
    clearDetectedModels(baseUrl);
  });

  /** How many times the model endpoint itself was asked for a completion. */
  let chatRequests = 0;

  /** Headers, then `frames`, then silence — the connection stays open. */
  function serveThenStall(frames: string[]): void {
    chatRequests = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen', meta: { n_ctx: 8192 } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      chatRequests++;
      const enc = new TextEncoder();
      const signal = init?.signal;
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(signal.reason ?? new Error('aborted'));
              } catch {
                // already closed
              }
            },
            { once: true },
          );
        },
        pull(controller) {
          if (i < frames.length) {
            controller.enqueue(enc.encode(`data: ${frames[i++]}\n\n`));
            return undefined;
          }
          return new Promise<void>(() => undefined);
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
  }

  async function stalledLocal(over: Record<string, unknown> = {}): Promise<Provider> {
    const { createOpenAiCompatibleProvider } = await import(
      '../src/providers/openai-compatible.ts'
    );
    return createOpenAiCompatibleProvider({
      baseUrl,
      model: '',
      modelTimeoutMs: 60,
      modelIdleTimeoutMs: 40,
      ...over,
    });
  }

  it('answers the turn from the second provider instead of failing', async () => {
    // The acceptance case. Driven through the real agent loop so the
    // classifier, the retry wrapper and the chain are all in it together.
    const { createAgentState, runAgentTurn } = await import('../src/agent/loop.ts');
    serveThenStall([]);
    const onFailover = vi.fn();

    const chain = createFallbackProvider(
      [
        { provider: await stalledLocal(), label: 'local' },
        { provider: working('anthropic answered'), label: 'anthropic' },
      ],
      { onFailover },
    );

    const result = await runAgentTurn(chain, createAgentState(), 'still there?');

    expect(result.reason).toBe('end-turn');
    expect(result.finalText).toBe('anthropic answered');
    expect(onFailover).toHaveBeenCalledWith(
      'local',
      'anthropic',
      expect.stringMatching(/timed|idle/),
    );
  });

  it('steps down when the stream opens and never delivers a token', async () => {
    // Streaming, but nothing reached the user yet — so there is no half-answer
    // on screen and the chain is free to move.
    serveThenStall([]);

    const chain = createFallbackProvider([
      { provider: await stalledLocal(), label: 'local' },
      { provider: working('second'), label: 'anthropic' },
    ]);

    const seen: string[] = [];
    const out = await chain.send(request({ onText: (d) => seen.push(d) }));

    expect(seen).toEqual([]);
    expect(out.content[0]).toMatchObject({ text: 'second' });
  });

  it('stays put once a token is already on screen', async () => {
    // The other half of the rule, unchanged: a partial answer cannot be
    // unsent, so the failure is reported rather than answered twice. It is
    // still classified as an availability failure, so the loop may retry it.
    serveThenStall(['{"choices":[{"delta":{"content":"Hel"}}]}']);
    const second = vi.fn();

    const chain = createFallbackProvider([
      { provider: await stalledLocal(), label: 'local' },
      { provider: { name: 'second', send: second }, label: 'anthropic' },
    ]);

    const err = await chain.send(request({ onText: () => undefined })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('unresponsive');
    expect(second).not.toHaveBeenCalled();
  });

  it('does not step down when the caller aborts the turn', async () => {
    // ESC. Same symptom at the controller, opposite meaning: the user asked
    // for nothing more, so a second provider must not be asked either.
    serveThenStall([]);
    const second = vi.fn();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    const slow = await stalledLocal({ modelTimeoutMs: 5_000, modelIdleTimeoutMs: 5_000 });
    const chain = createFallbackProvider([
      { provider: slow, label: 'local' },
      { provider: { name: 'second', send: second }, label: 'anthropic' },
    ]);

    const err = await chain.send(request({ signal: ctrl.signal })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('aborted');
    expect(second).not.toHaveBeenCalled();
  });

  it('gives up after ONE request when there is no fallback configured', async () => {
    // The default install: `providerFallback` is empty, so there is nothing to
    // step down to and the retry wrapper is all that is left. Retrying here
    // would mean five attempts against a 90s idle deadline — over seven
    // minutes of silence — for a server that has already demonstrated it is
    // not answering. `unresponsive` is failover-eligible but not retryable
    // precisely so this turn fails fast instead.
    const { createAgentState, runAgentTurn } = await import('../src/agent/loop.ts');
    serveThenStall([]);

    const local = await stalledLocal();
    const failed = await runAgentTurn(local, createAgentState(), 'still there?').catch(
      (e: unknown) => e,
    );

    expect(failed).toBeInstanceOf(ProviderError);
    expect((failed as ProviderError).kind).toBe('unresponsive');
    expect(chatRequests).toBe(1);
  });

  it('still retries a server it could not reach at all', async () => {
    // Connection refused: the request never landed, so a second attempt costs
    // nothing and often lands. This is the case that must NOT be swept up with
    // the silent-server one.
    const { createAgentState, runAgentTurn } = await import('../src/agent/loop.ts');
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const { createOpenAiCompatibleProvider } = await import(
      '../src/providers/openai-compatible.ts'
    );
    const local = createOpenAiCompatibleProvider({ baseUrl, model: 'pinned', maxTokens: 0 });

    const failed = await runAgentTurn(local, createAgentState(), 'hello', {
      maxRetries: 2,
    }).catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(ProviderError);
    expect((failed as ProviderError).kind).toBe('network');
    // Two send attempts; the /models probe is cached, so this counts sends.
    expect(attempts).toBeGreaterThan(1);
  });
});
