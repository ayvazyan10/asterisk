// Provider tests for the OpenAI-compatible backend. The wire shapes here are
// copied from a live llama.cpp llama-server (b1-726704a) — including its
// deepseek-style `reasoning_content` deltas and the usage-only final frame.

import { afterEach, describe, expect, it } from 'vitest';

import { ProviderError, isAbort, isRetryable } from '../src/providers/errors.ts';
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

/**
 * A server that accepts the request, sends `frames`, and then stops — the
 * llama-server hang the idle timeout exists for. Aborting the request signal
 * errors the body the way a real fetch does, which is what makes the pending
 * `reader.read()` reject with the timer's own reason.
 */
function stalls(frames: string[]): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    lastRequest = { url: String(url), init: init ?? {} };
    if (String(url).endsWith('/models')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const enc = new TextEncoder();
    const signal = init?.signal;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          'abort',
          () => {
            try {
              controller.error(signal.reason ?? new Error('aborted'));
            } catch {
              // already closed
            }
          },
          { once: true },
        );
      },
      pull(controller) {
        if (i < frames.length) {
          controller.enqueue(enc.encode(`data: ${frames[i++]}\n\n`));
          return undefined;
        }
        // Never settles: the connection is open and nothing more is coming.
        return new Promise<void>(() => undefined);
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

  it('strips a nested pattern keyword from tool schemas (llama.cpp grammar bug)', () => {
    const tools = toOpenAiTools([
      {
        name: 'notion-search',
        description: 'search notion',
        input_schema: {
          type: 'object',
          properties: {
            wrap: {
              type: 'object',
              properties: {
                date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              },
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(tools)).not.toContain('pattern');
  });

  it('strips a nested maxLength keyword from tool schemas (llama.cpp grammar bug)', () => {
    const tools = toOpenAiTools([
      {
        name: 'notion-query-meeting-notes',
        description: 'query notion',
        input_schema: {
          type: 'object',
          properties: {
            wrap: {
              type: 'object',
              properties: {
                notes: { type: 'string', maxLength: 2000 },
              },
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(tools)).not.toContain('maxLength');
  });

  it('keeps a property literally named "pattern" (e.g. Grep) intact', () => {
    const tools = toOpenAiTools([
      {
        name: 'grep',
        description: 'search',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string', description: 'Regex pattern.' } },
          required: ['pattern'],
        },
      },
    ]);
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'grep',
          description: 'search',
          parameters: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'Regex pattern.' } },
            required: ['pattern'],
          },
        },
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

  it('keeps parallel tool calls separate, ordered and correctly paired', async () => {
    // The elements of a non-streaming `message.tool_calls` carry no `index` —
    // the spec does not give them one. Reading a missing index as 0 dropped
    // all three into the same slot: last id, last name, every argument string
    // concatenated. The turn then ran ONE call, Grep, with Read's arguments,
    // and the other two vanished without an error. Two Edits of the same file
    // in one turn silently became one, reported as success.
    respond(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_a',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"path":"/a"}' },
                },
                {
                  id: 'call_b',
                  type: 'function',
                  function: { name: 'Read', arguments: '{"path":"/b"}' },
                },
                {
                  id: 'call_c',
                  type: 'function',
                  function: { name: 'Grep', arguments: '{"pattern":"x"}' },
                },
              ],
            },
          },
        ],
      }),
    );

    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);

    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'Read', input: { path: '/a' } },
      { type: 'tool_use', id: 'call_b', name: 'Read', input: { path: '/b' } },
      { type: 'tool_use', id: 'call_c', name: 'Grep', input: { pattern: 'x' } },
    ]);
  });

  it('still separates parallel calls when the server does send an index', async () => {
    // Some proxies mirror the streaming shape and number them anyway. Position
    // and index agree there, so nothing changes.
    respond(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'one', arguments: '{}' } },
                { index: 1, id: 'b', function: { name: 'two', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    );

    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect(res.content.map((b) => (b as ToolUseBlock).id)).toEqual(['a', 'b']);
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

describe('a stream that stops producing', () => {
  // There was no coverage here at all, and the two halves of send() disagreed:
  // the non-streaming half wrapped its timeout in a ProviderError, the
  // streaming half let the timer's own Error escape. Unclassified, it was not
  // an abort, not retryable, and — because fallback.ts tests `instanceof
  // ProviderError` — not a reason to step down to the next backend either. The
  // agent loop ended the turn with an unhandled exception.
  //
  // Classified is only half of it. A timeout WE raised and an abort the CALLER
  // raised look identical at the controller and mean opposite things: the
  // first says this backend is not answering, the second says the user changed
  // their mind. Only the first may retry and step down the chain.
  const stalled = { model: 'm', modelIdleTimeoutMs: 30, modelTimeoutMs: 5_000 };

  it('reports an idle timeout as an availability failure, not a cancellation', async () => {
    stalls(['{"choices":[{"delta":{"content":"Hel"}}]}']);

    const seen: string[] = [];
    const err = await createOpenAiCompatibleProvider(stalled)
      .send({ ...base, onText: (d) => seen.push(d) })
      .catch((e: unknown) => e);

    expect(seen).toEqual(['Hel']); // the first chunk did arrive
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
    expect((err as ProviderError).message).toMatch(/idle timeout/);
    // Retryable and failover-eligible; not the user's doing.
    expect(isRetryable(err)).toBe(true);
    expect(isAbort(err)).toBe(false);
  });

  it('reports the total timeout the same way', async () => {
    stalls(['{"choices":[{"delta":{"content":"Hel"}}]}']);

    const err = await createOpenAiCompatibleProvider({
      model: 'm',
      modelIdleTimeoutMs: 0,
      modelTimeoutMs: 30,
    })
      .send({ ...base, onText: () => undefined })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
    expect((err as ProviderError).message).toMatch(/timed out after/);
    expect(isRetryable(err)).toBe(true);
  });

  it('reports a timeout on the non-streaming body the same way', async () => {
    // The branch sub-agents, scheduled runs and the bot daemon all use. The
    // headers arrive, `res.json()` never resolves, and until now the rejection
    // was not wrapped at all — there was no try around it.
    stalls([]);

    const err = await createOpenAiCompatibleProvider({
      model: 'm',
      modelIdleTimeoutMs: 0,
      modelTimeoutMs: 30,
    })
      .send(base)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('network');
    expect(isRetryable(err)).toBe(true);
  });

  it('still calls a caller abort a cancellation — the REPL ESC path', async () => {
    // abort() with no reason gives a DOMException, not an Error. ESC must not
    // retry and must not move the turn to another provider.
    stalls(['{"choices":[{"delta":{"content":"Hel"}}]}']);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    const err = await createOpenAiCompatibleProvider({ model: 'm', modelIdleTimeoutMs: 5_000 })
      .send({ ...base, signal: ctrl.signal, onText: () => undefined })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('aborted');
    expect(isAbort(err)).toBe(true);
    expect(isRetryable(err)).toBe(false);
  });

  it('calls a caller abort a cancellation on the non-streaming branch too', async () => {
    stalls([]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);

    const err = await createOpenAiCompatibleProvider({ model: 'm', modelTimeoutMs: 5_000 })
      .send({ ...base, signal: ctrl.signal })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('aborted');
    expect(isAbort(err)).toBe(true);
  });
});
