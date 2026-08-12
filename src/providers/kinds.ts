// Provider kind constants, kept dependency-free so anything that needs to name
// a provider can import them without pulling in the factory.

export const PROVIDER_KINDS = ['ollama', 'openai-compatible', 'anthropic'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
