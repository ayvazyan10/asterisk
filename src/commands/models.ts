// Model discovery for the /model and /config flows.
//
// Shared by registry.ts and config-flows.ts, so it lives on its own rather
// than being imported back out of the registry — that would close an import
// cycle at value level.

import { loadConfig, saveConfig } from '../config/load.ts';
import { ConfigSchema } from '../config/schema.ts';
import { createProviderChain } from '../providers/factory.ts';
import type { ProviderKind } from '../providers/kinds.ts';
import type { FormSpec } from '../repl/forms/types.ts';
import type { CommandContext } from './registry.ts';

/**
 * Model ids an OpenAI-compatible endpoint advertises.
 *
 * llama.cpp, LM Studio and vLLM all serve `/v1/models`, and the ids they return
 * are the ones their own `/v1/chat/completions` accepts. Asking them beats
 * offering a list from a different vendor — which is what `/model` used to do
 * on this provider, writing Claude ids into `openaiCompatible.model`.
 */
export async function listOpenAiCompatibleModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
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
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

export const DEEPSEEK_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
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

export type { ProviderKind } from '../providers/kinds.ts';

/** Splits `<kind>:<model>`; model ids may contain colons, so only the first splits. */
export function parseProviderName(name: string): { kind: ProviderKind; model: string } | null {
  const colon = name.indexOf(':');
  if (colon === -1) return null;
  const kind = name.slice(0, colon);
  const model = name.slice(colon + 1).split(' → ')[0] ?? '';
  if (kind !== 'openai-compatible' && kind !== 'anthropic' && kind !== 'deepseek') return null;
  return { kind, model };
}

/** Edits the active backend's effort without changing its current model. */
export function reasoningForm(ctx: CommandContext): FormSpec | string {
  const current = parseProviderName(ctx.provider.name);
  if (!current) return `cannot parse current provider: ${ctx.provider.name}`;
  const key = current.kind === 'openai-compatible' ? 'openaiCompatible' : current.kind;
  const cfg = loadConfig().config;
  const schema = ConfigSchema.shape[key].removeDefault().shape.reasoningEffort.removeDefault();
  return {
    kind: 'form',
    title: `Reasoning level — ${current.kind}`,
    fields: [
      {
        kind: 'select',
        key: 'reasoningEffort',
        label: 'Reasoning level',
        defaultValue: cfg[key].reasoningEffort,
        options: schema.options.map((value) => ({
          value,
          label: value === 'default' ? 'default — let the model decide' : value,
        })),
      },
    ],
    onSubmit(values) {
      const loaded = loadConfig();
      const effort = schema.parse(values['reasoningEffort'] ?? loaded.config[key].reasoningEffort);
      loaded.config[key].reasoningEffort = effort;
      saveConfig(loaded.config);
      // /model and /provider can have selected a model only for this session.
      loaded.config.provider = current.kind;
      loaded.config[key].model = current.model === 'auto' ? '' : current.model;
      ctx.setProvider(createProviderChain(loaded).provider);
      return `✓ ${current.kind} reasoning level set to ${effort}`;
    },
    onCancel: () => null,
  };
}
