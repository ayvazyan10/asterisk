// Provider kind constants, kept dependency-free so anything that needs to name
// a provider can import them without pulling in the factory.
//
// `openai-compatible` is the local path and the default: llama.cpp's
// llama-server, LM Studio, vLLM, Jan, LocalAI, or any proxy speaking
// /v1/chat/completions. Ollama had its own provider until 0.4.2 — see the
// CHANGELOG for why one local path is better than two.

export const PROVIDER_KINDS = ['openai-compatible', 'anthropic'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
