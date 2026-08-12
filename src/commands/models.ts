// Model discovery for the /model and /config flows.
//
// Shared by registry.ts and config-flows.ts, so it lives on its own rather
// than being imported back out of the registry — that would close an import
// cycle at value level.

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Static fallback used when /v1/models can't be reached (no key, network
// error, or the endpoint is throttled). Ordered newest-first so the visible
// default lands on a current model.
// Retired ids are omitted deliberately — offering one only produces a 404 at
// the first request. Sonnet 3.5 retired 2025-10-28; Sonnet 3.7 and Haiku 3.5
// retired 2026-02-19.
export const ANTHROPIC_FALLBACK_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
];

export interface AnthropicModel {
  id: string;
  label: string;
}

export async function listAnthropicModels(apiKey: string): Promise<AnthropicModel[]> {
  if (!apiKey) return [...ANTHROPIC_FALLBACK_MODELS];
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [...ANTHROPIC_FALLBACK_MODELS];
    const data = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string }>;
    };
    const fetched = (data.data ?? []).map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
    }));
    return fetched.length > 0 ? fetched : [...ANTHROPIC_FALLBACK_MODELS];
  } catch {
    return [...ANTHROPIC_FALLBACK_MODELS];
  }
}

export type ProviderKind = 'ollama' | 'openai-compatible' | 'anthropic';

/** Splits `<kind>:<model>`; model ids may contain colons, so only the first splits. */
export function parseProviderName(name: string): { kind: ProviderKind; model: string } | null {
  const colon = name.indexOf(':');
  if (colon === -1) return null;
  const kind = name.slice(0, colon);
  const model = name.slice(colon + 1);
  if (kind !== 'ollama' && kind !== 'openai-compatible' && kind !== 'anthropic') return null;
  return { kind, model };
}
