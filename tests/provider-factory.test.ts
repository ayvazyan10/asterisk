import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadedConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { createAnthropicProvider } from '../src/providers/anthropic.ts';
import { chooseProvider, createProviderFromConfig } from '../src/providers/factory.ts';
import { clearDetectedModels } from '../src/providers/model-detect.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  clearDetectedModels();
});

const loaded = (
  config: Parameters<typeof ConfigSchema.parse>[0],
  secrets: LoadedConfig['secrets'] = {},
): LoadedConfig => ({ config: ConfigSchema.parse(config), secrets });

describe('provider factory', () => {
  it('builds primary deepseek with the configured endpoint, model and token cap', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const chosen = chooseProvider(
      loaded(
        {
          provider: 'deepseek',
          deepseek: { baseUrl: 'https://deepseek.invalid/v1', model: 'pinned', maxTokens: 123 },
        },
        { DEEPSEEK_API_KEY: 'test-key' },
      ),
    );
    expect(chosen.kind).toBe('deepseek');
    expect(chosen.provider.name).toBe('deepseek:pinned');
    expect(chosen.provider.contextWindow).toBe(1_000_000);
    expect(chosen.fallbackReason).toBeUndefined();
    await chosen.provider.refresh?.();
    expect(await chosen.provider.supportsImages?.()).toBe(false);
    await chosen.provider.send({ system: '', messages: [], tools: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://deepseek.invalid/v1/chat/completions');
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      model: 'pinned',
      max_tokens: 123,
    });
  });

  it('falls back to the local endpoint when deepseek has no key, and says why', () => {
    const chosen = chooseProvider(loaded({ provider: 'deepseek' }));
    expect(chosen.kind).toBe('openai-compatible');
    expect(chosen.provider.name).toBe('openai-compatible:auto');
    expect(chosen.fallbackReason).toBe('deepseek selected but DEEPSEEK_API_KEY is not set');
  });

  it('defaults to a local → deepseek chain when the key is present', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).startsWith('http://local.invalid/')) throw new TypeError('fetch failed');
      return Response.json({ choices: [{ message: { content: 'deepseek answered' } }] });
    }) as unknown as typeof fetch;
    const provider = createProviderFromConfig(
      loaded(
        {
          openaiCompatible: { baseUrl: 'http://local.invalid/v1', model: 'local' },
        },
        { DEEPSEEK_API_KEY: 'test-key' },
      ),
    );
    expect(provider.name).toBe('openai-compatible:local → deepseek:deepseek-flash');
    const reply = await provider.send({ system: '', messages: [], tools: [] });
    expect(reply.content).toEqual([{ type: 'text', text: 'deepseek answered' }]);
    expect(urls).toEqual([
      'http://local.invalid/v1/models',
      'https://api.deepseek.com/chat/completions',
    ]);
  });

  it('uses the local server first even when a DeepSeek key is present', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return String(url).endsWith('/models')
        ? Response.json({ data: [{ id: 'local' }] })
        : Response.json({ choices: [{ message: { content: 'local answered' } }] });
    }) as unknown as typeof fetch;
    const provider = createProviderFromConfig(loaded({}, { DEEPSEEK_API_KEY: 'test-key' }));
    const reply = await provider.send({ system: '', messages: [], tools: [] });
    expect(reply.content).toEqual([{ type: 'text', text: 'local answered' }]);
    expect(urls).toEqual([
      'http://127.0.0.1:8080/v1/models',
      'http://127.0.0.1:8080/v1/chat/completions',
    ]);
  });

  it('skips a failed local link briefly and picks it back up automatically', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const urls: string[] = [];
    let localUp = false;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const local = String(url).startsWith('http://');
      if (local && !localUp) throw new TypeError('connection refused');
      return String(url).endsWith('/models')
        ? Response.json({ data: [{ id: 'local' }] })
        : Response.json({ choices: [{ message: { content: local ? 'local' : 'deepseek' } }] });
    }) as unknown as typeof fetch;
    const provider = createProviderFromConfig(loaded({}, { DEEPSEEK_API_KEY: 'test-key' }));
    const req = { system: '', messages: [], tools: [] };
    expect((await provider.send(req)).content[0]).toMatchObject({ text: 'deepseek' });
    localUp = true;
    expect((await provider.send(req)).content[0]).toMatchObject({ text: 'deepseek' });
    clock.mockReturnValue(61_000);
    expect((await provider.send(req)).content[0]).toMatchObject({ text: 'local' });
    expect(urls).toEqual([
      'http://127.0.0.1:8080/v1/models',
      'https://api.deepseek.com/chat/completions',
      'https://api.deepseek.com/chat/completions',
      'http://127.0.0.1:8080/v1/models',
      'http://127.0.0.1:8080/v1/chat/completions',
    ]);
  });

  it('keeps explicit stored fallback and model settings', () => {
    const cfg = loaded({ providerFallback: [], anthropic: { model: 'claude-haiku-4-5' } });
    expect(cfg.config.providerFallback).toEqual([]);
    expect(cfg.config.anthropic.model).toBe('claude-haiku-4-5');
    expect(createProviderFromConfig({ ...cfg, secrets: { DEEPSEEK_API_KEY: 'key' } }).name).toBe(
      'openai-compatible:auto',
    );
  });

  it('defaults reasoning to server choice and Anthropic to current Opus', () => {
    const cfg = loaded({}).config;
    expect(cfg.openaiCompatible.reasoningEffort).toBe('default');
    expect(cfg.deepseek.reasoningEffort).toBe('default');
    expect(cfg.anthropic.reasoningEffort).toBe('default');
    expect(cfg.providerFallback).toEqual(['deepseek']);
    expect(cfg.anthropic.model).toBe('claude-opus-5-5');
  });

  it.each(['openai-compatible', 'deepseek'] as const)(
    'threads the configured reasoning level to %s',
    async (provider) => {
      let body: Record<string, unknown> = {};
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
      }) as unknown as typeof fetch;
      const chosen = chooseProvider(
        loaded(
          {
            provider,
            openaiCompatible: { model: 'local', reasoningEffort: 'low' },
            deepseek: { reasoningEffort: 'low' },
          },
          { DEEPSEEK_API_KEY: 'test-key' },
        ),
      );
      await chosen.provider.send({ system: '', messages: [], tools: [] });
      expect(body['reasoning_effort']).toBe('low');
      expect(body['thinking']).toEqual(provider === 'deepseek' ? { type: 'enabled' } : undefined);
    },
  );

  it('drops the deepseek link when its key is absent', () => {
    const provider = createProviderFromConfig(
      loaded({ openaiCompatible: { model: 'local' }, providerFallback: ['deepseek'] }),
    );
    expect(provider.name).toBe('openai-compatible:local');
  });

  it('defaults to the local endpoint, naming the pinned model when there is one', () => {
    const chosen = chooseProvider(loaded({ openaiCompatible: { model: 'qwen3.5:9b' } }));
    expect(chosen.kind).toBe('openai-compatible');
    expect(chosen.provider.name).toBe('openai-compatible:qwen3.5:9b');
    expect(chosen.fallbackReason).toBeUndefined();
  });

  it('reports the model as auto until the server has been asked', () => {
    // Nothing pinned and no detection yet: the name must not claim a model.
    const chosen = chooseProvider(loaded({}));
    expect(chosen.provider.name).toBe('openai-compatible:auto');
    expect(chosen.provider.contextWindow).toBeUndefined();
  });

  it('builds an openai-compatible provider', () => {
    const chosen = chooseProvider(
      loaded({
        provider: 'openai-compatible',
        openaiCompatible: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'gemma-4-26b' },
      }),
    );
    expect(chosen.kind).toBe('openai-compatible');
    expect(chosen.provider.name).toBe('openai-compatible:gemma-4-26b');
  });

  it('builds anthropic when a key is present', () => {
    const chosen = chooseProvider(
      loaded(
        { provider: 'anthropic', anthropic: { model: 'claude-haiku-4-5' } },
        {
          ANTHROPIC_API_KEY: 'sk-test',
        },
      ),
    );
    expect(chosen.kind).toBe('anthropic');
    expect(chosen.provider.name).toBe('anthropic:claude-haiku-4-5');
  });

  it('falls back to the local endpoint when anthropic has no key, and says why', () => {
    const chosen = chooseProvider(loaded({ provider: 'anthropic' }));
    expect(chosen.kind).toBe('openai-compatible');
    expect(chosen.fallbackReason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('does not fall back for a local provider — a bad URL must surface as an error', () => {
    const chosen = chooseProvider(
      loaded({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://nope:1/v1' } }),
    );
    expect(chosen.kind).toBe('openai-compatible');
    expect(chosen.fallbackReason).toBeUndefined();
  });
});

describe('Anthropic provider requests', () => {
  let bodies: Array<Record<string, unknown>>;
  beforeEach(() => {
    bodies = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Response.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;
  });

  it.each(['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'sends the configured %s effort through the factory',
    async (reasoningEffort) => {
      const provider = chooseProvider(
        loaded(
          { provider: 'anthropic', anthropic: { reasoningEffort } },
          { ANTHROPIC_API_KEY: 'test-key' },
        ),
      ).provider;
      await provider.send({ system: '', messages: [], tools: [] });
      expect(bodies[0]?.['model']).toBe('claude-opus-5-5');
      expect(bodies[0]?.['output_config']).toEqual(
        reasoningEffort === 'default' ? undefined : { effort: reasoningEffort },
      );
      expect(bodies[0]).not.toHaveProperty('thinking');
      expect(JSON.stringify(bodies[0])).not.toContain('budget_tokens');
    },
  );

  it.each([
    'claude-fable-5-2',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-haiku-5-5',
  ])('supports xhigh on %s with a 1M context window', async (model) => {
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      model,
      reasoningEffort: 'xhigh',
    });
    await provider.send({ system: '', messages: [], tools: [] });
    expect(bodies[0]?.['output_config']).toEqual({ effort: 'xhigh' });
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(provider.contextWindow).toBe(1_000_000);
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6'])('clamps only xhigh on %s', async (model) => {
    for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      await createAnthropicProvider({ apiKey: 'test-key', model, reasoningEffort }).send({
        system: '',
        messages: [],
        tools: [],
      });
      expect(bodies.at(-1)?.['output_config']).toEqual({
        effort: reasoningEffort === 'xhigh' ? 'high' : reasoningEffort,
      });
    }
  });

  it.each(['claude-haiku-4-5', 'claude-sonnet-4-5'])('omits effort on %s', async (model) => {
    for (const reasoningEffort of ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const provider = createAnthropicProvider({ apiKey: 'test-key', model, reasoningEffort });
      await provider.send({ system: '', messages: [], tools: [] });
      expect(bodies.at(-1)).not.toHaveProperty('output_config');
      expect(bodies.at(-1)).not.toHaveProperty('thinking');
      expect(provider.contextWindow).toBe(model === 'claude-haiku-4-5' ? 200_000 : 1_000_000);
    }
  });

  it('threads the Anthropic fallback effort too', async () => {
    const respond = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('http://')) throw new TypeError('connection refused');
      return respond(url, init);
    }) as unknown as typeof fetch;
    const provider = createProviderFromConfig(
      loaded(
        { providerFallback: ['anthropic'], anthropic: { reasoningEffort: 'max' } },
        { ANTHROPIC_API_KEY: 'test-key' },
      ),
    );
    await provider.send({ system: '', messages: [], tools: [] });
    expect(bodies[0]?.['output_config']).toEqual({ effort: 'max' });
  });

  it('strips DeepSeek history metadata from Anthropic content', async () => {
    const block = {
      type: 'text' as const,
      text: 'prior answer',
      reasoning_content: 'prior reasoning',
    };
    await createAnthropicProvider({ apiKey: 'test-key' }).send({
      system: '',
      messages: [{ role: 'assistant', content: [block] }],
      tools: [],
    });
    expect(bodies[0]?.['messages']).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] },
    ]);
  });

  it('sends effort on the streaming path', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_stream',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ];
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    const reply = await createAnthropicProvider({
      apiKey: 'test-key',
      reasoningEffort: 'low',
    }).send({
      system: '',
      messages: [],
      tools: [],
      onText: (delta) => seen.push(delta),
    });
    expect(bodies[0]).toMatchObject({ output_config: { effort: 'low' }, stream: true });
    expect(seen).toEqual(['ok']);
    expect(reply.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
