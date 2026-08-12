// The single place a Provider is built from configuration.
//
// This used to be four near-identical `pickProvider` functions (REPL entry,
// daemon, sub-agent, /reset) that had already drifted apart — the sub-agent
// copy silently dropped Ollama's `think` flag, and the REPL copy ignored the
// stored config entirely. Everything routes through here now.

import type { LoadedConfig } from '../config/load.ts';
import type { AsteriskConfig } from '../config/schema.ts';
import type { Provider } from '../types/messages.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { createOllamaProvider } from './ollama.ts';
import { createOpenAiCompatibleProvider } from './openai-compatible.ts';

export type { ProviderKind } from './kinds.ts';

export interface ProviderChoice {
  provider: Provider;
  /** Which backend was actually used — may differ from the request on fallback. */
  kind: AsteriskConfig['provider'];
  /** Set when the configured provider could not be used. */
  fallbackReason?: string;
}

/**
 * Builds the configured provider, falling back to Ollama when Anthropic is
 * selected without a key. Local providers never fall back — a wrong base URL
 * should surface as a connection error, not a silent switch.
 */
export function chooseProvider(loaded: LoadedConfig): ProviderChoice {
  const { config, secrets } = loaded;

  if (config.provider === 'anthropic') {
    const apiKey = secrets.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        provider: buildOllama(config),
        kind: 'ollama',
        fallbackReason: 'anthropic selected but ANTHROPIC_API_KEY is not set',
      };
    }
    return {
      provider: createAnthropicProvider({ apiKey, model: config.anthropic.model }),
      kind: 'anthropic',
    };
  }

  if (config.provider === 'openai-compatible') {
    return { provider: buildOpenAiCompatible(loaded), kind: 'openai-compatible' };
  }

  return { provider: buildOllama(config), kind: 'ollama' };
}

/** Convenience wrapper for callers that don't care why a fallback happened. */
export function createProviderFromConfig(loaded: LoadedConfig): Provider {
  return chooseProvider(loaded).provider;
}

function buildOllama(config: AsteriskConfig): Provider {
  return createOllamaProvider({
    baseUrl: config.ollama.baseUrl,
    model: config.ollama.model,
    contextWindow: config.ollama.contextWindow,
    think: config.ollama.think,
    modelTimeoutMs: config.ollama.modelTimeoutMs,
    modelIdleTimeoutMs: config.ollama.modelIdleTimeoutMs,
  });
}

function buildOpenAiCompatible(loaded: LoadedConfig): Provider {
  const cfg = loaded.config.openaiCompatible;
  return createOpenAiCompatibleProvider({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: loaded.secrets.ASTERISK_OPENAI_API_KEY ?? '',
    maxTokens: cfg.maxTokens,
    modelTimeoutMs: cfg.modelTimeoutMs,
    modelIdleTimeoutMs: cfg.modelIdleTimeoutMs,
  });
}
