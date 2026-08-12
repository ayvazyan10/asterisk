// Anthropic provider — thin wrapper over the public @anthropic-ai/sdk.
// Reference: https://github.com/anthropics/anthropic-sdk-typescript

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  Provider,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
} from '../types/messages.ts';
import { ProviderError, classifyHttpError } from './errors.ts';

/** Prompt-caching counters the API returns but the pinned SDK does not type. */
interface CacheUsage {
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Present-only cache counters, shaped for exactOptionalPropertyTypes. */
function cacheCounters(
  usage: CacheUsage,
): Pick<TokenUsage, 'cacheCreationInputTokens' | 'cacheReadInputTokens'> {
  const out: Pick<TokenUsage, 'cacheCreationInputTokens' | 'cacheReadInputTokens'> = {};
  if (typeof usage.cache_creation_input_tokens === 'number') {
    out.cacheCreationInputTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    out.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  return out;
}

interface AnthropicConfig {
  apiKey: string;
  model: string;
}

// Haiku 3.5 retired 2026-02-19; `claude-haiku-4-5` is its replacement.
const DEFAULT_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5';

export function createAnthropicProvider(overrides: Partial<AnthropicConfig> = {}): Provider {
  const apiKey = overrides.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required to use the Anthropic provider');
  }
  const model = overrides.model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  return {
    name: `anthropic:${model}`,
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      let response: Anthropic.Messages.Message;
      try {
        const requestOptions = req.signal ? { signal: req.signal } : {};
        const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: req.maxTokens ?? 4096,
          // cache_control is supported by the API but not yet in the stable SDK
          // types — cast through unknown to enable prompt caching.
          system: [
            {
              type: 'text' as const,
              text: req.system,
              cache_control: { type: 'ephemeral' as const },
            },
          ] as unknown as Anthropic.Messages.TextBlockParam[],
          // The SDK's input message shape matches our internal Message shape
          // closely enough; cast through unknown to bridge the structural gap.
          messages: req.messages.map((m) => ({
            role: m.role === 'system' ? 'user' : m.role,
            content: m.content as unknown as Anthropic.Messages.MessageParam['content'],
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

      // The cache counters are returned by the API but absent from the pinned
      // SDK's Usage type. Narrow structurally rather than with `any`, which the
      // project's own style rules ban — and add the optional keys only when
      // they are present, because exactOptionalPropertyTypes rejects an
      // explicit undefined.
      const usage: TokenUsage | undefined = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            ...cacheCounters(response.usage as CacheUsage),
          }
        : undefined;

      return { content, stopReason, ...(usage ? { usage } : {}) };
    },
  };
}

export function mapAnthropicError(e: unknown): ProviderError {
  if ((e as Error)?.name === 'AbortError') {
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
    const headers = (e.headers ?? {}) as Record<string, string>;
    const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'];
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
