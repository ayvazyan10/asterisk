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
import { type FallbackLink, createFallbackProvider } from './fallback.ts';
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

/**
 * Builds the provider chain: the chosen backend, then anything in
 * `providerFallback` that is usable and not already in front of it.
 *
 * A backend that cannot be constructed at all — Anthropic with no key — is
 * dropped here rather than added and left to fail on first use, so the chain
 * only contains links that could plausibly answer.
 */
export function createProviderChain(loaded: LoadedConfig): ProviderChoice {
  const head = chooseProvider(loaded);
  const wanted = loaded.config.providerFallback.filter((kind) => kind !== head.kind);
  if (wanted.length === 0) return head;

  const links: FallbackLink[] = [{ provider: head.provider, label: head.provider.name }];
  for (const kind of wanted) {
    const built = buildKind(kind, loaded);
    if (built) links.push({ provider: built, label: built.name });
  }
  if (links.length === 1) return head;

  return { ...head, provider: createFallbackProvider(links) };
}

/** Builds one backend by name, or null when it cannot be built. */
function buildKind(kind: AsteriskConfig['provider'], loaded: LoadedConfig): Provider | null {
  try {
    if (kind === 'anthropic') {
      const apiKey = loaded.secrets.ANTHROPIC_API_KEY;
      // Without a key this link could only ever contribute an auth failure.
      return apiKey
        ? createAnthropicProvider({ apiKey, model: loaded.config.anthropic.model })
        : null;
    }
    if (kind === 'openai-compatible') return buildOpenAiCompatible(loaded);
    return buildOllama(loaded.config);
  } catch {
    return null;
  }
}

/** Convenience wrapper for callers that don't care why a fallback happened. */
export function createProviderFromConfig(loaded: LoadedConfig): Provider {
  return createProviderChain(loaded).provider;
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
    contextWindow: cfg.contextWindow,
    modelTimeoutMs: cfg.modelTimeoutMs,
    modelIdleTimeoutMs: cfg.modelIdleTimeoutMs,
  });
}
