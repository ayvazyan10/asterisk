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

interface OllamaConfig {
  baseUrl: string;
  model: string;
  contextWindow: number;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

const DEFAULTS: OllamaConfig = {
  baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://127.0.0.1:11434',
  model: process.env['OLLAMA_MODEL'] ?? 'qwen3.5:9b-q8-max',
  contextWindow: Number(process.env['OLLAMA_CONTEXT_WINDOW'] ?? 131072),
};

function flattenForOllama(messages: Message[]): OllamaMessage[] {
  // Ollama expects a flat string content per message and uses separate
  // entries for tool results. Translate Anthropic-style content blocks down.
  const out: OllamaMessage[] = [];

  for (const msg of messages) {
    const textParts: string[] = [];
    const toolCalls: OllamaToolCall[] = [];
    const toolResults: { id: string; content: string; isError: boolean }[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') textParts.push(block.text);
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
      if (textParts.length > 0) {
        out.push({ role: msg.role, content: textParts.join('\n') });
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

function blocksFromOllama(msg: OllamaMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const cleaned = stripThinkTags(msg.content ?? '');
  if (cleaned.length > 0) {
    blocks.push({ type: 'text', text: cleaned });
  }
  if (msg.tool_calls) {
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const call = msg.tool_calls[i];
      if (!call) continue;
      const tu: ToolUseBlock = {
        type: 'tool_use',
        id: `ollama_call_${Date.now()}_${i}`,
        name: call.function.name,
        input: call.function.arguments,
      };
      blocks.push(tu);
    }
  }
  return blocks;
}

export function createOllamaProvider(overrides: Partial<OllamaConfig> = {}): Provider {
  const cfg: OllamaConfig = { ...DEFAULTS, ...overrides };

  return {
    name: `ollama:${cfg.model}`,
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      const body = {
        model: cfg.model,
        stream: false,
        options: { num_ctx: cfg.contextWindow },
        messages: [
          { role: 'system', content: req.system } satisfies OllamaMessage,
          ...flattenForOllama(req.messages),
        ],
        tools: req.tools.length > 0 ? toOllamaTools(req.tools) : undefined,
      };

      const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`;
      const fetchInit: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
      if (req.signal) fetchInit.signal = req.signal;
      let res: Response;
      try {
        res = await fetch(url, fetchInit);
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          throw new ProviderError('aborted', 'request aborted', { cause: e });
        }
        throw new ProviderError('network', `network error reaching ${url}: ${(e as Error).message}`, {
          cause: e,
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
        throw classifyHttpError(res.status, text, retryAfterSeconds);
      }

      const data = (await res.json()) as OllamaChatResponse;
      const content = blocksFromOllama(data.message);
      const stopReason: ProviderResponse['stopReason'] = content.some(
        (b) => b.type === 'tool_use',
      )
        ? 'tool_use'
        : 'end_turn';
      return { content, stopReason };
    },
  };
}
