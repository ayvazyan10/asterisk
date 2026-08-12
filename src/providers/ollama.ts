// Ollama provider — direct HTTP client for the /api/chat endpoint.
// Reference: https://github.com/ollama/ollama/blob/main/docs/api.md

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
import {
  type RepetitionOptions,
  createRepetitionGuard,
  findRunawayRepetition,
} from './repetition.ts';
import { parseToolArguments } from './tool-repair.ts';

interface OllamaConfig {
  baseUrl: string;
  model: string;
  contextWindow: number;
  think: boolean;
  modelTimeoutMs: number;
  modelIdleTimeoutMs: number;
  /** Thresholds for the runaway-repetition detector; see repetition.ts. */
  repetition?: RepetitionOptions;
}

interface OllamaToolCall {
  function?: {
    name?: string;
    /** Documented as an object, and that is what Ollama sends for models with
     *  a tool-aware template. Models whose template emits the arguments as a
     *  JSON string get that string passed straight through, and spreading a
     *  string into the tool input used to produce `{0:'{',1:'"',…}`. */
    arguments?: unknown;
  };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Newer thinking-aware Ollama models (qwen3-*-thinking, deepseek-r1, …)
   *  put their chain-of-thought in this structured field instead of inline
   *  <think>…</think> tags. We surface its tokens via onThinking but keep
   *  it OUT of the assistant's visible content so the agent doesn't see
   *  reasoning as part of its reply. */
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  /** base64 images, no data: prefix. Vision models read these; text-only
   *  models ignore the field rather than failing the request. */
  images?: string[];
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  // Token counts. Present only on the final frame (done: true); Ollama omits
  // them entirely on older builds, hence the optionality.
  // Reference: https://github.com/ollama/ollama/blob/main/docs/api.md#response-10
  prompt_eval_count?: number;
  eval_count?: number;
}

const DEFAULTS: OllamaConfig = {
  baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://127.0.0.1:11434',
  model: process.env['OLLAMA_MODEL'] ?? 'carstenuhlig/omnicoder-9b:q8_0',
  contextWindow: Number(process.env['OLLAMA_CONTEXT_WINDOW'] ?? 65536),
  think: process.env['OLLAMA_THINK'] !== '0' && process.env['OLLAMA_THINK'] !== 'false',
  modelTimeoutMs: Number(process.env['OLLAMA_MODEL_TIMEOUT_MS'] ?? 300_000),
  modelIdleTimeoutMs: Number(process.env['OLLAMA_MODEL_IDLE_TIMEOUT_MS'] ?? 90_000),
};

export function flattenForOllama(messages: Message[]): OllamaMessage[] {
  // Ollama expects a flat string content per message and uses separate
  // entries for tool results. Translate Anthropic-style content blocks down.
  const out: OllamaMessage[] = [];

  for (const msg of messages) {
    const textParts: string[] = [];
    const toolCalls: OllamaToolCall[] = [];
    const toolResults: { id: string; content: string; isError: boolean }[] = [];
    // Ollama hangs images off the message rather than treating them as content
    // blocks, so they are collected here and attached below.
    const images: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'image') images.push(block.data);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          function: { name: block.name, arguments: block.input },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          id: block.tool_use_id,
          content: block.content,
          isError: block.is_error ?? false,
        });
      }
    }

    if (msg.role === 'user' || msg.role === 'system') {
      if (textParts.length > 0 || images.length > 0) {
        const entry: OllamaMessage = { role: msg.role, content: textParts.join('\n') };
        if (images.length > 0) entry.images = images;
        out.push(entry);
      }
      for (const r of toolResults) {
        out.push({
          role: 'tool',
          content: r.isError ? `[error] ${r.content}` : r.content,
          tool_name: r.id,
        });
      }
    } else if (msg.role === 'assistant') {
      const entry: OllamaMessage = {
        role: 'assistant',
        content: textParts.join('\n'),
      };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    }
  }

  return out;
}

function toOllamaTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Some Ollama models (qwen3-thinking, deepseek-r1, …) interleave their
// chain-of-thought as <think>…</think> in the content stream. The user only
// wants the final answer, so strip:
//   - well-formed blocks  →  remove the whole <think>…</think>
//   - orphan </think>     →  drop everything before it (opening tag truncated
//                            during streaming or by the model template)
//   - orphan <think>      →  drop the tag, keep the rest as visible text
export function stripThinkTags(text: string): string {
  if (!text) return text;
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const lastClose = out.toLowerCase().lastIndexOf('</think>');
  if (lastClose !== -1) {
    out = out.slice(lastClose + '</think>'.length);
  }
  out = out.replace(/<think>/gi, '');
  return out.trim();
}

function blocksFromOllama(
  msg: OllamaMessage | undefined,
  repetition?: RepetitionOptions,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  // A response without a `message` is not something Ollama documents, but a
  // proxy sitting in front of it can produce one, and reading `.content` off
  // undefined took the whole turn down with a TypeError.
  if (!msg) return blocks;
  const cleaned = stripThinkTags(collapseRunaway(msg.content ?? '', repetition));
  if (cleaned.length > 0) {
    blocks.push({ type: 'text', text: cleaned });
  }
  if (msg.tool_calls) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const call = msg.tool_calls[i];
      const name = call?.function?.name;
      // A call with no name cannot be dispatched or usefully reported — the
      // model named nothing, so there is nothing to correct it towards.
      if (typeof name !== 'string' || !name.trim()) continue;
      const tu: ToolUseBlock = {
        type: 'tool_use',
        id: `ollama_call_${Date.now()}_${i}`,
        name,
        input: parseToolArguments(call?.function?.arguments, name),
      };
      blocks.push(tu);
    }
  }
  return blocks;
}

/** Truncates a completion that degenerated into a repeating loop back to one
 *  copy of the repeated unit. See providers/repetition.ts for the thresholds.
 *
 *  Cutting the text short can leave a <think> block open, and stripThinkTags
 *  treats an orphan opener as visible text — which would publish exactly the
 *  reasoning the filter exists to hide. Close it on the way out. */
function collapseRunaway(text: string, options?: RepetitionOptions): string {
  const hit = findRunawayRepetition(text, options ?? {});
  if (hit === null) return text;
  const kept = text.slice(0, hit.start + hit.unit.length);
  const lower = kept.toLowerCase();
  return lower.lastIndexOf('<think>') > lower.lastIndexOf('</think>') ? `${kept}</think>` : kept;
}

export function createOllamaProvider(overrides: Partial<OllamaConfig> = {}): Provider {
  const cfg: OllamaConfig = { ...DEFAULTS, ...overrides };

  return {
    name: `ollama:${cfg.model}`,
    contextWindow: cfg.contextWindow,
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      const onText = req.onText;
      const streaming = onText !== undefined;
      const body: Record<string, unknown> = {
        model: cfg.model,
        stream: streaming,
        think: cfg.think,
        options: { num_ctx: cfg.contextWindow },
        messages: [
          { role: 'system', content: req.system } satisfies OllamaMessage,
          ...flattenForOllama(req.messages),
        ],
        tools: req.tools.length > 0 ? toOllamaTools(req.tools) : undefined,
      };

      const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`;

      // Layer a total-timeout AbortController on top of the caller's signal.
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

      const fetchInit: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      };
      try {
        let res: Response;
        try {
          res = await fetch(url, fetchInit);
        } catch (e) {
          if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) {
            const reason = ctrl.signal.reason;
            const msg = reason instanceof Error ? reason.message : 'request aborted';
            throw new ProviderError('aborted', msg, { cause: e });
          }
          throw new ProviderError(
            'network',
            `network error reaching ${url}: ${(e as Error).message}`,
            {
              cause: e,
            },
          );
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
          throw classifyHttpError(res.status, text, retryAfterSeconds);
        }

        let finalMessage: OllamaMessage | undefined;
        let runaway = false;
        if (onText) {
          const streamed = await readStreamingChat(
            res,
            onText,
            req.onThinking,
            cfg.modelIdleTimeoutMs,
            ctrl,
            cfg.repetition,
          );
          finalMessage = streamed.message;
          runaway = streamed.runaway;
        } else {
          const parsed = (await res.json()) as OllamaChatResponse | null;
          finalMessage = parsed?.message;
        }

        const content = blocksFromOllama(finalMessage, cfg.repetition);
        const stopReason: ProviderResponse['stopReason'] = content.some(
          (b) => b.type === 'tool_use',
        )
          ? 'tool_use'
          : runaway
            ? 'stop_sequence'
            : 'end_turn';
        return { content, stopReason };
      } finally {
        clearTimeout(totalTimer);
        if (req.signal) req.signal.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  NDJSON streaming reader. Ollama emits one JSON object per line:
//    { "message": { "role": "assistant", "content": "<delta>" }, "done": false }
//  with the last line carrying done:true and possibly any tool_calls.
// ─────────────────────────────────────────────────────────────────────────

async function readStreamingChat(
  res: Response,
  onText: (delta: string) => void,
  onThinking?: (delta: string) => void,
  idleTimeoutMs?: number,
  ctrl?: AbortController,
  repetitionOptions?: RepetitionOptions,
): Promise<{ message: OllamaMessage; runaway: boolean }> {
  if (!res.body) {
    const data = (await res.json()) as OllamaChatResponse | null;
    return { message: data?.message ?? { role: 'assistant', content: '' }, runaway: false };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let aggregatedContent = '';
  let toolCalls: OllamaToolCall[] | undefined;
  const filter = createThinkFilter();
  const repetition = createRepetitionGuard(repetitionOptions ?? {});
  let runaway = false;

  // Idle timeout: abort if no chunk arrives for idleTimeoutMs.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (idleTimeoutMs && ctrl) {
      idleTimer = setTimeout(() => {
        ctrl.abort(
          new Error(`model idle timeout — no data for ${Math.round(idleTimeoutMs / 1000)}s`),
        );
      }, idleTimeoutMs);
    }
  };
  resetIdleTimer();

  // Cancel the reader when the AbortController fires so reader.read()
  // rejects instead of blocking forever on a stalled stream.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (ctrl) {
    if (ctrl.signal.aborted) reader.cancel().catch(() => {});
    else ctrl.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (ctrl?.signal.aborted) break;
      resetIdleTimer();
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      for (; nl !== -1; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: OllamaChatResponse;
        try {
          ev = JSON.parse(line) as OllamaChatResponse;
        } catch {
          // Skip malformed lines defensively.
          continue;
        }
        const delta = ev.message?.content ?? '';
        if (delta) {
          aggregatedContent += delta;
          if (repetition.push(delta)) runaway = true;
          const out = filter.feed(delta);
          if (out.visible) {
            try {
              onText(out.visible);
            } catch {
              // sink errors must not abort the model call
            }
          }
          if (out.thinking && onThinking) {
            try {
              onThinking(out.thinking);
            } catch {
              // sink errors must not abort the model call
            }
          }
        }
        // Newer Ollama API: thinking arrives as a STRUCTURED field per
        // frame (separate from message.content). Surface its tokens via
        // onThinking so the UI shows reasoning progress; never let it
        // bleed into onText (the agent must not see chain-of-thought).
        const thinkDelta = ev.message?.thinking ?? '';
        if (thinkDelta && onThinking) {
          try {
            onThinking(thinkDelta);
          } catch {
            // ignore
          }
        }
        if (ev.message?.tool_calls && ev.message.tool_calls.length > 0) {
          toolCalls = ev.message.tool_calls;
        }
      }
      // A model repeating itself will not stop on its own; cancelling the
      // reader closes the connection so Ollama stops generating, instead of
      // filling the context window and running down the total timeout.
      if (runaway) {
        buf = '';
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (ctrl) ctrl.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  // Process any remaining data in buf — the final Ollama frame may lack a
  // trailing newline, leaving its JSON (including tool_calls) unprocessed.
  const remainder = buf.trim();
  if (remainder) {
    try {
      const ev = JSON.parse(remainder) as OllamaChatResponse;
      const delta = ev.message?.content ?? '';
      if (delta) aggregatedContent += delta;
      if (ev.message?.tool_calls && ev.message.tool_calls.length > 0) {
        toolCalls = ev.message.tool_calls;
      }
    } catch {
      // ignore malformed trailing data
    }
  }
  // Flush any held-back tail through the think filter so onText sees the
  // tail of the final answer that arrived without a trailing newline.
  const tail = filter.flush();
  if (tail) {
    try {
      onText(tail);
    } catch {
      // ignore
    }
  }

  // If the controller was aborted (total or idle timeout), throw so the
  // caller sees the timeout rather than a truncated response.
  if (ctrl?.signal.aborted) {
    const reason = ctrl.signal.reason;
    const msg = reason instanceof Error ? reason.message : 'model response aborted';
    throw new ProviderError('aborted', msg, { cause: reason });
  }

  const out: OllamaMessage = { role: 'assistant', content: aggregatedContent };
  if (toolCalls) out.tool_calls = toolCalls;
  return { message: out, runaway };
}

/** Split the chain-of-thought block (<think>…</think>) out from the visible
 *  answer. Some Ollama models (qwen3-thinking, deepseek-r1) interleave
 *  reasoning into the content stream — we want the final assistant text to
 *  contain only the answer, but during streaming we surface the thinking
 *  separately so the UI can render "thinking · N chars" progress instead of
 *  appearing hung during a long reasoning phase.
 *
 *  Chars after the last `<` in the buffer might be the start of an
 *  unfinished tag — we hold those back; everything before the last `<` is
 *  safe to emit. flush() drains whatever remained at EOS. */
function createThinkFilter(): {
  feed(chunk: string): { visible: string; thinking: string };
  flush(): string;
} {
  let buf = '';
  let inside = false;
  return {
    feed(chunk: string): { visible: string; thinking: string } {
      buf += chunk;
      let visible = '';
      let thinking = '';
      // Loop until no more *complete* tag can be resolved this turn.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!inside) {
          const lower = buf.toLowerCase();
          const open = lower.indexOf('<think>');
          // Orphan </think> without a preceding <think> — the model's
          // template injected the open tag outside the content stream
          // (e.g. omnicoder, some qwen3 templates). Drop everything up
          // to and including the close tag as hidden thinking.
          const orphanClose = lower.indexOf('</think>');
          if (orphanClose !== -1 && (open === -1 || orphanClose < open)) {
            thinking += buf.slice(0, orphanClose);
            buf = buf.slice(orphanClose + '</think>'.length);
            continue;
          }
          if (open !== -1) {
            visible += buf.slice(0, open);
            buf = buf.slice(open + '<think>'.length);
            inside = true;
            continue;
          }
          // No complete tag yet. Hold back from the LAST '<' onward —
          // those bytes might still complete into '<think>' or '</think>'.
          const lt = buf.lastIndexOf('<');
          if (lt === -1) {
            visible += buf;
            buf = '';
          } else {
            visible += buf.slice(0, lt);
            buf = buf.slice(lt);
          }
          break;
        }
        const close = buf.toLowerCase().indexOf('</think>');
        if (close !== -1) {
          thinking += buf.slice(0, close);
          buf = buf.slice(close + '</think>'.length);
          inside = false;
          continue;
        }
        // Inside but no close yet — emit everything up to the last '<' as
        // thinking; hold the tail in case it grows into '</think>'.
        const lt = buf.lastIndexOf('<');
        if (lt === -1) {
          thinking += buf;
          buf = '';
        } else {
          thinking += buf.slice(0, lt);
          buf = buf.slice(lt);
        }
        break;
      }
      return { visible, thinking };
    },
    flush(): string {
      // End of stream. If still inside an unclosed block, drop it. Otherwise
      // emit any held-back tail (couldn't have been a real tag after all).
      if (inside) {
        buf = '';
        return '';
      }
      const out = buf;
      buf = '';
      return out;
    },
  };
}
