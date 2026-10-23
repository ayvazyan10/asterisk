import { afterEach, describe, expect, it } from 'vitest';

import type { LoadedConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { chooseProvider, createProviderFromConfig } from '../src/providers/factory.ts';
import { clearDetectedModels } from '../src/providers/model-detect.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
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

  it('builds and uses a local → deepseek chain when the key is present', async () => {
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
          providerFallback: ['deepseek'],
        },
        { DEEPSEEK_API_KEY: 'test-key' },
      ),
    );
    expect(provider.name).toBe('openai-compatible:local → deepseek:deepseek-flash');
    const reply = await provider.send({ system: '', messages: [], tools: [] });
    expect(reply.content).toEqual([{ type: 'text', text: 'deepseek answered' }]);
    expect(urls).toEqual([
      'http://local.invalid/v1/models',
      'http://local.invalid/v1/chat/completions',
      'https://api.deepseek.com/chat/completions',
    ]);
  });

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
