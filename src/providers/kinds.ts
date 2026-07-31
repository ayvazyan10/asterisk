// Provider kind constants, kept dependency-free so both the provider factory
// and the usage recorder can import them without a cycle.

export const PROVIDER_KINDS = ['ollama', 'openai-compatible', 'anthropic'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Backends that run on hardware the user already owns, so a turn has no
 * per-token cost. `openai-compatible` counts because it is the local-model
 * path — if it is pointed at a paid hosted endpoint, an explicit price row
 * for that model overrides this and is used instead.
 */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'openai-compatible']);

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider);
}
