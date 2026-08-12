import { describe, expect, it } from 'vitest';

import type { LoadedConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { chooseProvider, createProviderFromConfig } from '../src/providers/factory.ts';
import { isLocalProvider } from '../src/providers/kinds.ts';

const loaded = (
  config: Parameters<typeof ConfigSchema.parse>[0],
  secrets: LoadedConfig['secrets'] = {},
): LoadedConfig => ({ config: ConfigSchema.parse(config), secrets });

describe('provider factory', () => {
  it('defaults to ollama with the configured model', () => {
    const chosen = chooseProvider(loaded({ ollama: { model: 'qwen3.5:9b' } }));
    expect(chosen.kind).toBe('ollama');
    expect(chosen.provider.name).toBe('ollama:qwen3.5:9b');
    expect(chosen.fallbackReason).toBeUndefined();
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

  it('falls back to ollama when anthropic has no key, and says why', () => {
    const chosen = chooseProvider(loaded({ provider: 'anthropic' }));
    expect(chosen.kind).toBe('ollama');
    expect(chosen.fallbackReason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('does not fall back for a local provider — a bad URL must surface as an error', () => {
    const chosen = chooseProvider(
      loaded({ provider: 'openai-compatible', openaiCompatible: { baseUrl: 'http://nope:1/v1' } }),
    );
    expect(chosen.kind).toBe('openai-compatible');
    expect(chosen.fallbackReason).toBeUndefined();
  });

  it('exposes a plain constructor for callers that ignore the reason', () => {
    expect(createProviderFromConfig(loaded({})).name).toMatch(/^ollama:/);
  });
});

describe('local provider classification', () => {
  it('treats the local backends as zero-cost', () => {
    expect(isLocalProvider('ollama')).toBe(true);
    expect(isLocalProvider('openai-compatible')).toBe(true);
  });

  it('does not treat anthropic as local', () => {
    expect(isLocalProvider('anthropic')).toBe(false);
    expect(isLocalProvider('something-else')).toBe(false);
  });
});
