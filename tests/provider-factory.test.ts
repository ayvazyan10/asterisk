import { describe, expect, it } from 'vitest';

import type { LoadedConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { chooseProvider, createProviderFromConfig } from '../src/providers/factory.ts';

const loaded = (
  config: Parameters<typeof ConfigSchema.parse>[0],
  secrets: LoadedConfig['secrets'] = {},
): LoadedConfig => ({ config: ConfigSchema.parse(config), secrets });

describe('provider factory', () => {
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
