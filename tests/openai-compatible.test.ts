// Provider tests for the OpenAI-compatible backend. The wire shapes here are
// copied from a live llama.cpp llama-server (b1-726704a) — including its
// deepseek-style `reasoning_content` deltas and the usage-only final frame.

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderError } from '../src/providers/errors.ts';
import {
  createOpenAiCompatibleProvider,
  toOpenAiMessages,
  toOpenAiTools,
} from '../src/providers/openai-compatible.ts';
import type { Message, TextBlock, ToolUseBlock } from '../src/types/messages.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let lastRequest: { url: string; init: RequestInit } | null = null;

function respond(body: BodyInit | null, status = 200): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    lastRequest = { url: String(url), init: init ?? {} };
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

function sse(frames: string[]): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    lastRequest = { url: String(url), init: init ?? {} };
    const enc = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i >= frames.length) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(enc.encode(`data: ${frames[i++]}\n\n`));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

const base = { system: 'sys', messages: [], tools: [] };

describe('message conversion', () => {
  it('prepends the system prompt', () => {
    expect(toOpenAiMessages('be brief', [])).toEqual([{ role: 'system', content: 'be brief' }]);
  });

  it('omits an empty system prompt', () => {
    expect(toOpenAiMessages('', [])).toEqual([]);
  });

  it('maps assistant tool_use to tool_calls with stringified arguments', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/tmp/a' } },
        ],
      },
    ];
    expect(toOpenAiMessages('', messages)).toEqual([
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"/tmp/a"}' },
          },
        ],
      },
    ]);
  });

  it('hoists tool results into their own tool-role messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file body' },
          { type: 'text', text: 'now summarise it' },
        ],
      },
    ];
    // Results must land before the new user text so the tool call is answered
    // before the next instruction.
    expect(toOpenAiMessages('', messages)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'user', content: 'now summarise it' },
    ]);
  });

  it('marks failed tool results so the model can react', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c', content: 'no such file', is_error: true },
        ],
      },
    ];
    expect(toOpenAiMessages('', messages)[0]).toMatchObject({ content: 'ERROR: no such file' });
  });

  it('converts tool definitions to the function schema', () => {
    expect(
      toOpenAiTools([{ name: 'grep', description: 'search', input_schema: { type: 'object' } }]),
    ).toEqual([
      {
        type: 'function',
        function: { name: 'grep', description: 'search', parameters: { type: 'object' } },
      },
    ]);
  });
});

describe('non-streaming responses', () => {
  it('returns text', async () => {
    respond(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );

    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect((res.content[0] as TextBlock).text).toBe('hello');
    expect(res.stopReason).toBe('end_turn');
  });

  it('converts tool_calls into tool_use blocks', async () => {
    respond(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'abc',
                  type: 'function',
                  function: { name: 'list_dir', arguments: '{"path":"/tmp"}' },
                },
              ],
            },
          },
        ],
      }),
    );

    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect(res.stopReason).toBe('tool_use');
    expect(res.content[0]).toEqual({
      type: 'tool_use',
      id: 'abc',
      name: 'list_dir',
      input: { path: '/tmp' },
    });
  });

  it('surfaces reasoning_content through onThinking', async () => {
    respond(
      JSON.stringify({
        choices: [
          { finish_reason: 'stop', message: { content: 'answer', reasoning_content: 'pondering' } },
        ],
      }),
    );

    const thinking: string[] = [];
    await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onThinking: (d) => thinking.push(d),
    });
    expect(thinking).toEqual(['pondering']);
  });

  it('maps a length finish to max_tokens', async () => {
    respond(
      JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'trunc' } }] }),
    );
    expect((await createOpenAiCompatibleProvider({ model: 'm' }).send(base)).stopReason).toBe(
      'max_tokens',
    );
  });

  it('keeps malformed tool arguments as data instead of throwing', async () => {
    respond(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ id: 'z', function: { name: 'f', arguments: '{not json' } }] },
          },
        ],
      }),
    );
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect((res.content[0] as ToolUseBlock).input).toMatchObject({ __tool: 'f' });
  });
});

describe('requests', () => {
  it('posts to /chat/completions and normalises a trailing slash', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
    await createOpenAiCompatibleProvider({ baseUrl: 'http://host:8080/v1/', model: 'm' }).send(
      base,
    );
    expect(lastRequest?.url).toBe('http://host:8080/v1/chat/completions');
  });

  it('omits the Authorization header when no key is set', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
    await createOpenAiCompatibleProvider({ model: 'm', apiKey: '' }).send(base);
    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('sends a bearer token when a key is set', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
    await createOpenAiCompatibleProvider({ model: 'm', apiKey: 'sk-local' }).send(base);
    const headers = lastRequest?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-local');
  });

  it('omits the tools key when there are none', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: 'x' } }] }));
    await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect(JSON.parse(String(lastRequest?.init.body)).tools).toBeUndefined();
  });

  it('classifies an HTTP error', async () => {
    respond('server exploded', 500);
    await expect(createOpenAiCompatibleProvider({ model: 'm' }).send(base)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('streaming', () => {
  it('forwards text deltas and assembles the final text', async () => {
    sse([
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"}}]}',
      '{"choices":[{"finish_reason":"stop","delta":{}}]}',
      '{"choices":[],"usage":{"prompt_tokens":18,"completion_tokens":2}}',
      '[DONE]',
    ]);

    const seen: string[] = [];
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: (d) => seen.push(d),
    });

    expect(seen).toEqual(['Hel', 'lo']);
    expect((res.content[0] as TextBlock).text).toBe('Hello');
    expect(res.stopReason).toBe('end_turn');
  });

  it('routes reasoning_content to onThinking, not onText', async () => {
    sse([
      '{"choices":[{"delta":{"reasoning_content":"think "}}]}',
      '{"choices":[{"delta":{"reasoning_content":"more"}}]}',
      '{"choices":[{"delta":{"content":"done"}}]}',
      '[DONE]',
    ]);

    const text: string[] = [];
    const thinking: string[] = [];
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: (d) => text.push(d),
      onThinking: (d) => thinking.push(d),
    });

    expect(thinking).toEqual(['think ', 'more']);
    expect(text).toEqual(['done']);
    expect((res.content[0] as TextBlock).text).toBe('done');
  });

  it('reassembles tool calls split across frames', async () => {
    sse([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"list_dir","arguments":"{"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"path"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":\\"/tmp\\"}"}}]}}]}',
      '{"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
      '[DONE]',
    ]);

    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: () => {},
    });

    expect(res.stopReason).toBe('tool_use');
    expect(res.content[0]).toEqual({
      type: 'tool_use',
      id: 't1',
      name: 'list_dir',
      input: { path: '/tmp' },
    });
  });

  it('keeps parallel tool calls separate and ordered', async () => {
    sse([
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"two","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"one","arguments":"{}"}}]}}]}',
      '[DONE]',
    ]);

    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: () => {},
    });
    expect(res.content.map((b) => (b as ToolUseBlock).name)).toEqual(['one', 'two']);
  });

  it('ignores a truncated frame rather than failing the turn', async () => {
    sse(['{"choices":[{"delta":{"content":"ok"}}]}', '{not json', '[DONE]']);
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: () => {},
    });
    expect((res.content[0] as TextBlock).text).toBe('ok');
  });

  it('survives a throwing onText callback', async () => {
    sse(['{"choices":[{"delta":{"content":"a"}}]}', '[DONE]']);
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: () => {
        throw new Error('ui blew up');
      },
    });
    expect((res.content[0] as TextBlock).text).toBe('a');
  });
});
