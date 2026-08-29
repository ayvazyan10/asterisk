// Anthropic provider — thin wrapper over the public @anthropic-ai/sdk.
// Reference: https://github.com/anthropics/anthropic-sdk-typescript

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from '../types/messages.ts';
import { ProviderError, classifyHttpError } from './errors.ts';

interface AnthropicConfig {
  apiKey: string;
  model: string;
}

// Haiku 3.5 retired 2026-02-19; `claude-haiku-4-5` is its replacement.
const DEFAULT_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5';

/**
 * Bridges our content blocks to the Anthropic wire shape.
 *
 * Text, tool_use and tool_result already line up field for field, which is why
 * the rest of this file gets away with a cast. Images do not: ours carries the
 * base64 and media type flat, Anthropic nests them under `source`, and passing
 * ours through unchanged is silently accepted as an unknown block rather than
 * rejected — the model simply never sees the picture.
 */
export function toAnthropicContent(blocks: readonly ContentBlock[]): unknown[] {
  return blocks.map((block) => {
    if (block.type !== 'image') return block;
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mediaType, data: block.data },
    };
  });
}

export function createAnthropicProvider(overrides: Partial<AnthropicConfig> = {}): Provider {
  const apiKey = overrides.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to use the Anthropic provider');
  }
  const model = overrides.model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  return {
    name: `anthropic:${model}`,
    // Every current Claude model exposes at least a 200k window.
    contextWindow: 200_000,
    // Every model this SDK can address accepts image blocks; there is nothing
    // to detect and nothing a user would need to override.
    supportsImages: async (): Promise<boolean> => true,
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      let response: Anthropic.Messages.Message;
      try {
        const requestOptions = req.signal ? { signal: req.signal } : {};
        const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: req.maxTokens ?? 4096,
          // cache_control reached the stable SDK types in the 0.3x → 0.12x
          // window, so this is a plain TextBlockParam now — no cast.
          system: [
            {
              type: 'text',
              text: req.system,
              cache_control: { type: 'ephemeral' },
            },
          ] satisfies Anthropic.Messages.TextBlockParam[],
          // The SDK's input message shape matches our internal Message shape
          // closely enough; cast through unknown to bridge the structural gap.
          messages: req.messages.map((m) => ({
            role: m.role === 'system' ? 'user' : m.role,
            content: toAnthropicContent(
              m.content,
            ) as unknown as Anthropic.Messages.MessageParam['content'],
          })),
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
          })),
        };
        if (req.onText) {
          // Streaming path — SDK gives per-delta text events plus a final
          // assembled message (incl. tool_use blocks) on .finalMessage().
          // Reference: https://github.com/anthropics/anthropic-sdk-typescript#streaming
          const onText = req.onText;
          const stream = client.messages.stream(params, requestOptions);
          stream.on('text', (delta) => {
            try {
              onText(delta);
            } catch {
              // ignore — UI sink errors must not abort the model call
            }
          });
          response = await stream.finalMessage();
        } else {
          response = await client.messages.create(params, requestOptions);
        }
      } catch (e) {
        throw mapAnthropicError(e);
      }

      const content: ContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }

      const stopReason: ProviderResponse['stopReason'] =
        response.stop_reason === 'end_turn'
          ? 'end_turn'
          : response.stop_reason === 'tool_use'
            ? 'tool_use'
            : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : response.stop_reason === 'stop_sequence'
                ? 'stop_sequence'
                : 'unknown';

      return { content, stopReason };
    },
  };
}

/**
 * Reads one header off an APIError.
 *
 * The SDK hands us a `Headers`, but `mapAnthropicError` is also reachable with
 * whatever a proxy or an older client threw, so a plain record is accepted too
 * rather than throwing on `.get`.
 */
function readHeader(headers: Headers | undefined, lowercaseName: string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(lowercaseName) ?? undefined;
  const record = headers as unknown as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lowercaseName) return value;
  }
  return undefined;
}

export function mapAnthropicError(e: unknown): ProviderError {
  if ((e as Error)?.name === 'AbortError') {
    return new ProviderError('aborted', 'request aborted', { cause: e });
  }
  // What the SDK actually throws when the request signal fires. It carries no
  // `name` of its own and extends APIError with an undefined status, so both
  // checks below would otherwise have called a deliberate cancellation a
  // retryable network error and sent the turn back round the retry loop.
  if (e instanceof Anthropic.APIUserAbortError) {
    return new ProviderError('aborted', 'request aborted', { cause: e });
  }
  // APIConnectionError extends APIError in the SDK, so this check has to come
  // first. With the order reversed the connection branch below was unreachable
  // and every DNS failure, TLS reset and refused connection fell through to
  // classifyHttpError(0, …) → kind 'unknown', which is not in RETRYABLE_KINDS.
  // The most common transient failure there is bypassed the retry machinery
  // entirely and failed the turn on the first attempt.
  if (e instanceof Anthropic.APIConnectionError) {
    return new ProviderError('network', e.message ?? 'network error', { cause: e });
  }
  if (e instanceof Anthropic.APIError) {
    // `headers` is a web `Headers` instance now, not the plain object the SDK
    // used to expose. Indexing it returns undefined for every name, so the
    // server's Retry-After hint was silently dropped and rate-limit backoff
    // fell back to the built-in schedule. `.get()` is case-insensitive, which
    // is also why the second `Retry-After` lookup is gone.
    const retryAfterRaw = readHeader(e.headers, 'retry-after');
    const retryAfterSeconds = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : undefined;
    const body = typeof e.message === 'string' ? e.message : '';
    // A status of 0/undefined means the request never reached the API, so it is
    // a network failure regardless of which error class carried it.
    if (!e.status) {
      return new ProviderError('network', e.message ?? 'network error', { cause: e });
    }
    return classifyHttpError(
      e.status,
      body,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    );
  }
  return new ProviderError('unknown', (e as Error)?.message ?? 'unknown error', { cause: e });
}
