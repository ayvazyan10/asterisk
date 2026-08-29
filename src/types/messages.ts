// Provider-neutral message types used across the agent loop.
// Loosely modeled on the Anthropic Messages API public schema:
// https://docs.anthropic.com/en/api/messages

export type Role = 'system' | 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * An image the model can actually look at.
 *
 * Carried as base64 rather than a path because every provider wants the bytes
 * inline — Anthropic as a base64 source, OpenAI-compatible servers as an `image_url` part on the
 * message, OpenAI-compatible endpoints as a `data:` URI. A path would only be
 * meaningful to a model running on this machine, which is not a promise
 * Asterisk can make.
 */
export interface ImageBlock {
  type: 'image';
  /** Raw base64, with no `data:` prefix. */
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Where it came from, for transcripts and error messages. */
  source?: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional. If set, the provider should request a streamed response from
   *  the upstream API and call this with each text delta as it arrives.
   *  The returned ProviderResponse must still contain the full assembled
   *  content blocks (including any tool_use) — onText is purely for live UI. */
  onText?: (delta: string) => void;
  /** Optional. Fired with chain-of-thought tokens emitted inside <think>…
   *  </think> blocks (qwen3-thinking, deepseek-r1, …). Hidden from onText
   *  and from the final assembled content, but surfaced here so the UI
   *  can show "thinking · N chars" progress instead of looking hung
   *  during a long reasoning phase. */
  onThinking?: (delta: string) => void;
}

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown';
}

export interface Provider {
  name: string;
  /**
   * Tokens the model can hold, when the provider knows it. Compaction derives
   * its budget from this; a hardcoded threshold once sat above the typical
   * local window, so a default install overflowed before compaction ever
   * fired. The local provider reports the server's own n_ctx.
   */
  contextWindow?: number | undefined;
  /**
   * Whether an image block may be sent to this backend.
   *
   * Async, not a getter, because on the local path the honest answer needs the
   * server: whether the loaded model has an mmproj attached is published by
   * llama.cpp and guessable from nothing else (see providers/vision.ts). The
   * result is cached for a minute, so asking is cheap.
   *
   * Optional, and its absence means "no". A provider that has not thought
   * about images is one that should not be sent any — failing closed here
   * costs a caller one clear refusal, where failing open costs a mid-turn
   * provider error that names neither images nor the setting that fixes it.
   */
  supportsImages?(): Promise<boolean>;
  send(request: ProviderRequest): Promise<ProviderResponse>;
}
