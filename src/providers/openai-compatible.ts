// Provider for any OpenAI-compatible /chat/completions endpoint.
//
// This is the universal local-model path: llama.cpp's llama-server, LM Studio,
// vLLM, Jan, LocalAI, text-generation-webui, and any proxy that speaks the
// same wire format. It is also usable against hosted OpenAI-compatible APIs by
// setting an API key.
//
// The model name is not taken from configuration by default: a local server
// holds one model, the user swaps it by restarting the server, and a name in
// the config is a stale copy of a fact the server already publishes. See
// model-detect.ts.
//
// Reference: https://platform.openai.com/docs/api-reference/chat/create
// llama.cpp server: https://github.com/ggml-org/llama.cpp/tree/master/tools/server

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolDefinition,
  ToolUseBlock,
} from '../types/messages.ts';
import { ProviderError, classifyHttpError, parseRetryAfter } from './errors.ts';
import { type DetectedModel, detectActiveModel } from './model-detect.ts';
import {
  type RepetitionOptions,
  createRepetitionGuard,
  findRunawayRepetition,
} from './repetition.ts';
import { stripGrammarHostileKeywords } from './schema-sanitize.ts';
import { parseToolArguments } from './tool-repair.ts';

export interface OpenAiCompatibleConfig {
  /** Endpoint root including the version segment, e.g. http://127.0.0.1:8080/v1 */
  baseUrl: string;
  model: string;
  /** Sent as `Authorization: Bearer`. Local servers usually need none. */
  apiKey: string;
  /** Upper bound on generated tokens. 0 leaves it to the server. */
  maxTokens: number;
  contextWindow: number;
  modelTimeoutMs: number;
  modelIdleTimeoutMs: number;
  /** Thresholds for the runaway-repetition detector. Left at the defaults
   *  unless a caller has a reason; see providers/repetition.ts. */
  repetition?: RepetitionOptions;
}

export const OPENAI_COMPATIBLE_DEFAULTS: OpenAiCompatibleConfig = {
  baseUrl: process.env['OPENAI_BASE_URL'] ?? 'http://127.0.0.1:8080/v1',
  model: process.env['OPENAI_MODEL'] ?? '',
  apiKey: process.env['OPENAI_API_KEY'] ?? '',
  maxTokens: Number(process.env['OPENAI_MAX_TOKENS'] ?? 0),
  contextWindow: 0,
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

interface WireContentPart {
  type?: string;
  text?: string;
}

interface WireMessage {
  role?: string;
  /** The spec says string, and most servers oblige. Some proxies mirror the
   *  multimodal request shape back and answer with an array of parts, which
   *  used to reach `.trim()` and take the whole turn down with a TypeError. */
  content?: string | null | WireContentPart[];
  /** Emitted by llama.cpp under `--reasoning-format deepseek`, and by others. */
  reasoning_content?: string | null;
  tool_calls?: WireToolCall[];
}

/** Flattens either accepted content shape to plain text. */
function contentText(content: WireMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

interface WireChoice {
  index?: number;
  message?: WireMessage;
  delta?: WireMessage;
  finish_reason?: string | null;
}

interface WireResponse {
  choices?: WireChoice[];
  error?: { message?: string };
}

// --- request shaping -----------------------------------------------------

interface OutMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // A string for the ordinary case; the array form is what carries images, and
  // only vision-capable endpoints accept it — hence only used when there is an
  // image to send.
  content?: string | null | Array<Record<string, unknown>>;
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
    const images = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
    );
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
    if (images.length > 0) {
      // The multimodal shape: an array of parts rather than a bare string.
      // Reference: https://platform.openai.com/docs/guides/vision
      const parts: Array<Record<string, unknown>> = [];
      if (text) parts.push({ type: 'text', text });
      for (const image of images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.data}` },
        });
      }
      out.push({ role: 'user', content: parts });
    } else if (text) {
      out.push({ role: 'user', content: text });
    }
  }

  return out;
}

export function toOpenAiTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      // See schema-sanitize.ts: llama.cpp's grammar compiler rejects `pattern`
      // and large length/count bounds on nested properties, and all of them
      // are validation-only anyway — dropping them changes nothing about
      // what a correct tool call looks like.
      parameters: stripGrammarHostileKeywords(t.input_schema),
    },
  }));
}

/**
 * Accumulates tool-call fragments.
 *
 * Streaming and non-streaming replies identify a call differently, and reading
 * them the same way loses calls. In a stream the fragments of one call arrive
 * over several frames and `index` is the only thing tying a later arguments
 * chunk to the call it belongs to. A non-streaming reply carries whole calls in
 * `message.tool_calls` and, per the spec, no `index` at all — there, position
 * in the array is the identity.
 *
 * Reading a missing `index` as 0 therefore collapsed every parallel call in a
 * non-streaming reply into one: last id, last name, and every argument string
 * concatenated, of which `parseToolArguments` then read the first object. Two
 * of three calls vanished with no error, and the survivor ran under another
 * call's arguments. Everything that does not stream took that path —
 * sub-agents, scheduled runs, the eval runner.
 */
class ToolCallBuffer {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  /** A streamed fragment, keyed by the slot the server assigned it. */
  push(delta: WireToolCall): void {
    this.merge(delta.index ?? 0, delta);
  }

  /** A complete call from a non-streaming reply, keyed by array position. */
  pushComplete(call: WireToolCall, position: number): void {
    this.merge(position, call);
  }

  private merge(index: number, delta: WireToolCall): void {
    const prev = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
    this.byIndex.set(index, {
      id: delta.id || prev.id,
      name: delta.function?.name || prev.name,
      args: prev.args + (delta.function?.arguments ?? ''),
    });
  }

  blocks(): ToolUseBlock[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        type: 'tool_use' as const,
        id: call.id || `call_${index}`,
        name: call.name,
        // parseToolArguments never throws: a call it cannot read comes back
        // carrying the malformed sentinel, which the agent loop turns into a
        // tool_result the model can correct from.
        input: parseToolArguments(call.args, call.name),
      }));
  }

  get size(): number {
    return this.byIndex.size;
  }
}

function blocksFrom(message: WireMessage, repetition?: RepetitionOptions): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = collapseRunaway(contentText(message.content), repetition).trim();
  if (text) blocks.push({ type: 'text', text });

  const buffer = new ToolCallBuffer();
  for (const [position, call] of (message.tool_calls ?? []).entries()) {
    buffer.pushComplete(call, position);
  }
  blocks.push(...buffer.blocks());

  return blocks;
}

/** Non-streaming counterpart to the streaming guard: a looping model that
 *  answers in one shot still bloats history with kilobytes of the same line. */
function collapseRunaway(text: string, options?: RepetitionOptions): string {
  const hit = findRunawayRepetition(text, options ?? {});
  return hit === null ? text : text.slice(0, hit.start + hit.unit.length);
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

// --- cancellation classification -----------------------------------------
//
// Every cancellation in this module arrives through the same AbortController:
// the caller's signal, the total timeout and the stream's idle timeout all end
// up as `ctrl.abort(reason)`. Two questions follow from one rejection, and the
// old code answered neither consistently.
//
// What kind of failure is it? The streaming half read the body outside any
// try, so the plain Error the timers hand to `abort()` reached the agent loop
// verbatim: not a ProviderError, so `isAbort` and `isRetryable` both said no,
// retry declined, the fallback chain would not step down, and the turn ended
// with an unhandled exception and reason 'unknown-error'.
//
// And WHO cancelled? That is the difference between "the user changed their
// mind" and "this backend stopped answering", and only the source can tell
// them apart — the symptom is identical. A server that took the request and
// then went quiet past `modelIdleTimeoutMs` is an availability failure, which
// is precisely what a fallback chain is for (fallback.ts: "chain; availability
// failures only"). ESC is not: it must neither be retried nor answered by a
// different provider.
//
// So: caller's signal aborted -> 'aborted'. Our own timer -> 'unresponsive',
// the kind for "reached the backend, waited past a deadline, got nothing". It
// is in FAILOVER_KINDS and deliberately NOT in RETRYABLE_KINDS: the chain
// should move to another backend, and nothing should spend a second 90-second
// deadline on the server that just ignored the first. A failure to *reach* the
// server stays 'network' and stays retryable — the request never landed, so
// trying again is free.

/** The message a cancellation reason carries, whichever kind of object it is:
 *  an Error from the timers, a DOMException from a bare `abort()`. */
function reasonMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) return reason.message;
  const message = (reason as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : fallback;
}

/**
 * Classifies a cancellation by its source.
 *
 * `caller` is the signal the request came in with. If it has fired, the user
 * or the enclosing turn asked to stop and nothing else may be inferred; if it
 * has not, the only other thing holding this controller is one of our own
 * deadlines, and the backend is what failed — `unresponsive`, which fails over
 * without retrying.
 */
function cancellationError(
  reason: unknown,
  cause: unknown,
  fallback: string,
  caller: AbortSignal | undefined,
): ProviderError {
  const message = reasonMessage(reason, fallback);
  if (caller?.aborted) return new ProviderError('aborted', message, { cause });
  return new ProviderError('unresponsive', message, { cause });
}

/**
 * Classifies a response body that stopped producing.
 *
 * Aborting the controller rejects the in-flight read with the very reason it
 * was given, before control can reach the post-loop check — which is why that
 * check alone was not enough.
 */
function bodyFailure(
  error: unknown,
  ctrl: AbortController,
  caller: AbortSignal | undefined,
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (ctrl.signal.aborted) {
    return cancellationError(ctrl.signal.reason, error, 'model response aborted', caller);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return cancellationError(error, error, 'model response aborted', caller);
  }
  // The connection dropped, or the body was not what it claimed to be. Either
  // way this backend did not answer the request.
  return new ProviderError(
    'network',
    `response body failed: ${reasonMessage(error, String(error))}`,
    {
      cause: error,
    },
  );
}

// --- provider ------------------------------------------------------------

export function createOpenAiCompatibleProvider(
  overrides: Partial<OpenAiCompatibleConfig> = {},
): Provider {
  const cfg: OpenAiCompatibleConfig = { ...OPENAI_COMPATIBLE_DEFAULTS, ...overrides };
  const root = cfg.baseUrl.replace(/\/+$/, '');

  // What the server said it is serving, from the last detection. Held here so
  // `name` and `contextWindow` report the model that will actually answer,
  // rather than whatever the config was written against.
  let detected: DetectedModel | null = null;

  /**
   * Settles which model this request names.
   *
   * Detection wins over the configured name: a local server holds one model
   * and the user swaps it by restarting the server, so the server is the
   * authority and the config is the fallback for when it cannot be reached.
   */
  const resolveModel = async (): Promise<string> => {
    detected = await detectActiveModel(root, cfg.apiKey);
    const model = detected?.id || cfg.model;
    if (!model) {
      throw new ProviderError(
        'network',
        `no model to talk to: ${root}/models could not be reached and openaiCompatible.model is empty. Start the server, or pin a model name.`,
      );
    }
    return model;
  };

  return {
    get name(): string {
      return `openai-compatible:${detected?.id || cfg.model || 'auto'}`;
    },
    // The server's own n_ctx beats the configured guess; 0/undefined means
    // "unknown" and compaction falls back to its own default.
    get contextWindow(): number | undefined {
      // undefined means "unknown"; compaction falls back to its own default.
      const window = detected?.contextWindow ?? cfg.contextWindow;
      return window && window > 0 ? window : undefined;
    },
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      const streaming = !!req.onText;
      const maxTokens = req.maxTokens ?? (cfg.maxTokens > 0 ? cfg.maxTokens : undefined);
      const model = await resolveModel();

      const body: Record<string, unknown> = {
        model,
        messages: toOpenAiMessages(req.system, req.messages),
        stream: streaming,
        ...(req.tools.length > 0 ? { tools: toOpenAiTools(req.tools) } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        // Without this the final SSE frame carries no usage, and cost
        // tracking silently records nothing for every streamed turn.
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
            throw cancellationError(ctrl.signal.reason, e, 'request aborted', req.signal);
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

        // The body is a stream here too. A server that sends headers and then
        // goes quiet leaves this pending until one of our timers aborts it,
        // and the rejection carries the timer's own Error — the same hole the
        // streaming half had, in the branch every non-streaming caller uses:
        // sub-agents, scheduled runs, the eval runner, the bot daemon.
        let parsed: WireResponse;
        try {
          parsed = (await res.json()) as WireResponse;
        } catch (e) {
          throw bodyFailure(e, ctrl, req.signal);
        }
        if (parsed.error?.message) {
          throw new ProviderError('bad-request', parsed.error.message);
        }
        const choice = parsed.choices?.[0];
        const message = choice?.message ?? {};

        // Non-streaming reasoning still deserves to reach the UI.
        const reasoning = (message.reasoning_content ?? '').trim();
        if (reasoning) req.onThinking?.(reasoning);

        const content = blocksFrom(message, cfg.repetition);
        return {
          content,
          stopReason: mapStopReason(
            choice?.finish_reason,
            content.some((b) => b.type === 'tool_use'),
          ),
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
  const toolCalls = new ToolCallBuffer();
  const repetition = createRepetitionGuard(cfg.repetition ?? {});
  let runaway = false;

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

    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;

    const delta = choice.delta ?? {};
    const deltaText = contentText(delta.content);
    if (deltaText) {
      text += deltaText;
      if (repetition.push(deltaText)) runaway = true;
      try {
        req.onText?.(deltaText);
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
      // Stop pulling once the model is only repeating itself. Cancelling the
      // reader closes the connection, which is what actually stops the server
      // generating — otherwise this runs to the total timeout.
      if (runaway) {
        buf = '';
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (e) {
    // An idle or total timeout lands here, not on the check below: aborting
    // the controller rejects the pending read with the timer's own Error.
    throw bodyFailure(e, ctrl, req.signal);
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

  if (runaway) text = text.slice(0, repetition.keepLength());

  // Still reachable: a stream that ended cleanly while the signal was already
  // aborted (the caller cancelled between the last frame and here).
  if (ctrl.signal.aborted) {
    throw cancellationError(
      ctrl.signal.reason,
      ctrl.signal.reason,
      'model response aborted',
      req.signal,
    );
  }

  const content: ContentBlock[] = [];
  if (text.trim()) content.push({ type: 'text', text: text.trim() });
  content.push(...toolCalls.blocks());

  return {
    content,
    // A stream we cut short did not stop for the model's own reason, and
    // reporting it as end_turn would let a truncated loop look like a
    // finished answer.
    stopReason: runaway ? 'stop_sequence' : mapStopReason(finish, toolCalls.size > 0),
  };
}
