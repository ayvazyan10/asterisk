// Provider for any OpenAI-compatible /chat/completions endpoint.
//
// This is the universal local-model path: llama.cpp's llama-server, LM Studio,
// vLLM, Jan, LocalAI, text-generation-webui, and any proxy that speaks the
// same wire format. It is also usable against hosted OpenAI-compatible APIs by
// setting an API key.
//
// Ollama keeps its own provider because Asterisk drives its native /api/chat
// (num_ctx, think, NDJSON framing). Everything else goes through here.
//
// Reference: https://platform.openai.com/docs/api-reference/chat/create
// llama.cpp server: https://github.com/ggml-org/llama.cpp/tree/master/tools/server

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderRequest,
  ProviderResponse,
  TokenUsage,
  ToolDefinition,
  ToolUseBlock,
} from '../types/messages.ts';
import { ProviderError, classifyHttpError, parseRetryAfter } from './errors.ts';

export interface OpenAiCompatibleConfig {
  /** Endpoint root including the version segment, e.g. http://127.0.0.1:8080/v1 */
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer`. Local servers usually need none. */
  apiKey: string;
  /** Upper bound on generated tokens. 0 leaves it to the server. */
  maxTokens: number;
  modelTimeoutMs: number;
  modelIdleTimeoutMs: number;
}

export const OPENAI_COMPATIBLE_DEFAULTS: OpenAiCompatibleConfig = {
  baseUrl: process.env['OPENAI_BASE_URL'] ?? 'http://127.0.0.1:8080/v1',
  model: process.env['OPENAI_MODEL'] ?? '',
  apiKey: process.env['OPENAI_API_KEY'] ?? '',
  maxTokens: Number(process.env['OPENAI_MAX_TOKENS'] ?? 0),
  modelTimeoutMs: Number(process.env['OPENAI_MODEL_TIMEOUT_MS'] ?? 300_000),
  modelIdleTimeoutMs: Number(process.env['OPENAI_MODEL_IDLE_TIMEOUT_MS'] ?? 90_000),
};

// --- wire types ----------------------------------------------------------

interface WireToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | null;
  /** Emitted by llama.cpp under `--reasoning-format deepseek`, and by others. */
  reasoning_content?: string | null;
  tool_calls?: WireToolCall[];
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface WireChoice {
  index?: number;
  message?: WireMessage;
  delta?: WireMessage;
  finish_reason?: string | null;
}

interface WireResponse {
  choices?: WireChoice[];
  usage?: WireUsage;
  error?: { message?: string };
}

// --- request shaping -----------------------------------------------------

interface OutMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * Converts Asterisk's block-structured history into the flat OpenAI shape.
 *
 * The two models disagree in one important place: Asterisk carries tool
 * results as blocks inside a user message, while OpenAI wants each result as
 * its own `role: "tool"` message keyed by `tool_call_id`. Results are
 * therefore hoisted out and emitted as separate messages, in order.
 */
export function toOpenAiMessages(system: string, messages: readonly Message[]): OutMessage[] {
  const out: OutMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const message of messages) {
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const toolResults = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );

    if (message.role === 'assistant') {
      const entry: OutMessage = { role: 'assistant', content: text || null };
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map((u) => ({
          id: u.id,
          type: 'function' as const,
          function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    // Tool results must precede any new user text so the assistant's tool
    // calls are answered before the next instruction arrives.
    for (const result of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: result.is_error ? `ERROR: ${result.content}` : result.content,
      });
    }
    if (text) out.push({ role: 'user', content: text });
  }

  return out;
}

export function toOpenAiTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function usageFrom(usage: WireUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return {
    ...(typeof input === 'number' ? { inputTokens: input } : {}),
    ...(typeof output === 'number' ? { outputTokens: output } : {}),
    ...(typeof cached === 'number' && cached > 0 ? { cacheReadInputTokens: cached } : {}),
  };
}

/** Tool-call arguments arrive as JSON text; a malformed one must not kill the turn. */
function parseArguments(raw: string, toolName: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    // Surfaced to the model as a tool error rather than thrown, so it can retry.
    return { __malformed_arguments: trimmed, __tool: toolName };
  }
}

/** Accumulates streamed tool-call fragments, which arrive keyed by index. */
class ToolCallBuffer {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  push(delta: WireToolCall): void {
    const index = delta.index ?? 0;
    const existing = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
    if (delta.id) existing.id = delta.id;
    if (delta.function?.name) existing.name = delta.function.name;
    if (delta.function?.arguments) existing.args += delta.function.arguments;
    this.byIndex.set(index, existing);
  }

  blocks(): ToolUseBlock[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        type: 'tool_use' as const,
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseArguments(call.args, call.name),
      }));
  }

  get size(): number {
    return this.byIndex.size;
  }
}

function blocksFrom(message: WireMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = (message.content ?? '').trim();
  if (text) blocks.push({ type: 'text', text });

  const buffer = new ToolCallBuffer();
  for (const call of message.tool_calls ?? []) buffer.push(call);
  blocks.push(...buffer.blocks());

  return blocks;
}

function mapStopReason(
  finish: string | null | undefined,
  hasToolUse: boolean,
): ProviderResponse['stopReason'] {
  if (hasToolUse || finish === 'tool_calls') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'stop') return 'end_turn';
  return 'end_turn';
}

// --- provider ------------------------------------------------------------

export function createOpenAiCompatibleProvider(
  overrides: Partial<OpenAiCompatibleConfig> = {},
): Provider {
  const cfg: OpenAiCompatibleConfig = { ...OPENAI_COMPATIBLE_DEFAULTS, ...overrides };
  const root = cfg.baseUrl.replace(/\/+$/, '');

  return {
    name: `openai-compatible:${cfg.model || 'default'}`,
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      const streaming = !!req.onText;
      const maxTokens = req.maxTokens ?? (cfg.maxTokens > 0 ? cfg.maxTokens : undefined);

      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: toOpenAiMessages(req.system, req.messages),
        stream: streaming,
        ...(req.tools.length > 0 ? { tools: toOpenAiTools(req.tools) } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        // Without this the final SSE frame carries no usage, and cost
        // tracking silently records nothing for every streamed turn.
        ...(streaming ? { stream_options: { include_usage: true } } : {}),
      };

      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort(req.signal?.reason);
      if (req.signal) {
        if (req.signal.aborted) ctrl.abort(req.signal.reason);
        else req.signal.addEventListener('abort', onParentAbort, { once: true });
      }
      const totalTimer = setTimeout(() => {
        ctrl.abort(
          new Error(`model response timed out after ${Math.round(cfg.modelTimeoutMs / 1000)}s`),
        );
      }, cfg.modelTimeoutMs);

      try {
        let res: Response;
        try {
          res = await fetch(`${root}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        } catch (e) {
          if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) {
            const reason = ctrl.signal.reason;
            throw new ProviderError(
              'aborted',
              reason instanceof Error ? reason.message : 'request aborted',
              { cause: e },
            );
          }
          throw new ProviderError(
            'network',
            `network error reaching ${root}: ${(e as Error).message}`,
            { cause: e },
          );
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw classifyHttpError(
            res.status,
            text,
            parseRetryAfter(res.headers.get('retry-after')),
          );
        }

        if (streaming) {
          return await readStream(res, req, cfg, ctrl);
        }

        const parsed = (await res.json()) as WireResponse;
        if (parsed.error?.message) {
          throw new ProviderError('bad-request', parsed.error.message);
        }
        const choice = parsed.choices?.[0];
        const message = choice?.message ?? {};

        // Non-streaming reasoning still deserves to reach the UI.
        const reasoning = (message.reasoning_content ?? '').trim();
        if (reasoning) req.onThinking?.(reasoning);

        const content = blocksFrom(message);
        const usage = usageFrom(parsed.usage);
        return {
          content,
          stopReason: mapStopReason(
            choice?.finish_reason,
            content.some((b) => b.type === 'tool_use'),
          ),
          ...(usage ? { usage } : {}),
        };
      } finally {
        clearTimeout(totalTimer);
        if (req.signal) req.signal.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

/**
 * Consumes an SSE stream of `data:` frames, forwarding text deltas to onText
 * and reasoning deltas to onThinking while assembling the final blocks.
 */
async function readStream(
  res: Response,
  req: ProviderRequest,
  cfg: OpenAiCompatibleConfig,
  ctrl: AbortController,
): Promise<ProviderResponse> {
  if (!res.body) throw new ProviderError('network', 'streaming response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let finish: string | null | undefined;
  let usage: TokenUsage | undefined;
  const toolCalls = new ToolCallBuffer();

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (cfg.modelIdleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        ctrl.abort(
          new Error(
            `model idle timeout — no data for ${Math.round(cfg.modelIdleTimeoutMs / 1000)}s`,
          ),
        );
      }, cfg.modelIdleTimeoutMs);
    }
  };

  const handleFrame = (raw: string): void => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let event: WireResponse;
    try {
      event = JSON.parse(payload) as WireResponse;
    } catch {
      return; // a truncated frame is not worth failing the turn over
    }

    if (event.usage) usage = usageFrom(event.usage) ?? usage;

    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (delta.content) {
      text += delta.content;
      try {
        req.onText?.(delta.content);
      } catch {
        // a throwing UI callback must not abort generation
      }
    }
    if (delta.reasoning_content) {
      try {
        req.onThinking?.(delta.reasoning_content);
      } catch {
        // same
      }
    }
    for (const call of delta.tool_calls ?? []) toolCalls.push(call);
  };

  resetIdle();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buf += decoder.decode(value, { stream: true });

      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        handleFrame(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  // The last frame may arrive without a trailing newline.
  if (buf.trim()) handleFrame(buf);

  if (ctrl.signal.aborted) {
    const reason = ctrl.signal.reason;
    throw new ProviderError(
      'aborted',
      reason instanceof Error ? reason.message : 'model response aborted',
      { cause: reason },
    );
  }

  const content: ContentBlock[] = [];
  if (text.trim()) content.push({ type: 'text', text: text.trim() });
  content.push(...toolCalls.blocks());

  return {
    content,
    stopReason: mapStopReason(finish, toolCalls.size > 0),
    ...(usage ? { usage } : {}),
  };
}
