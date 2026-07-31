// Ollama reports token counts on its final frame (`prompt_eval_count` /
// `eval_count`). These tests pin that they survive both the streaming and the
// non-streaming path, including the awkward case where the last frame arrives
// without a trailing newline.

import { afterEach, describe, expect, it } from 'vitest';

import { createOllamaProvider } from '../src/providers/ollama.ts';

const realFetch = globalThis.fetch;

function streamOf(lines: string[], { trailingNewline = true } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= lines.length) {
        ctrl.close();
        return;
      }
      const last = i === lines.length - 1;
      const line = lines[i++] ?? '';
      ctrl.enqueue(enc.encode(last && !trailingNewline ? line : `${line}\n`));
    },
  });
}

function respondWith(body: BodyInit | null, streaming: boolean): void {
  // The stub has no `preconnect`, so the cast goes through `unknown`.
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': streaming ? 'application/x-ndjson' : 'application/json' },
    })) as unknown as typeof fetch;
}

const request = { system: 'sys', messages: [], tools: [] };

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Ollama token usage', () => {
  it('captures counts from a non-streaming response', async () => {
    respondWith(
      JSON.stringify({
        message: { role: 'assistant', content: 'hi' },
        done: true,
        prompt_eval_count: 120,
        eval_count: 34,
      }),
      false,
    );

    const provider = createOllamaProvider({ model: 'test' });
    const res = await provider.send(request);
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
  });

  it('captures counts from the final streaming frame', async () => {
    respondWith(
      streamOf([
        JSON.stringify({ message: { role: 'assistant', content: 'a' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: 'b' }, done: false }),
        JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
          prompt_eval_count: 900,
          eval_count: 77,
        }),
      ]),
      true,
    );

    const provider = createOllamaProvider({ model: 'test' });
    const res = await provider.send({ ...request, onText: () => {} });
    expect(res.usage).toEqual({ inputTokens: 900, outputTokens: 77 });
  });

  it('captures counts when the final frame lacks a trailing newline', async () => {
    respondWith(
      streamOf(
        [
          JSON.stringify({ message: { role: 'assistant', content: 'a' }, done: false }),
          JSON.stringify({
            message: { role: 'assistant', content: 'b' },
            done: true,
            prompt_eval_count: 5,
            eval_count: 6,
          }),
        ],
        { trailingNewline: false },
      ),
      true,
    );

    const provider = createOllamaProvider({ model: 'test' });
    const res = await provider.send({ ...request, onText: () => {} });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it('omits usage when the server reports no counters', async () => {
    respondWith(
      JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true }),
      false,
    );

    const provider = createOllamaProvider({ model: 'test' });
    const res = await provider.send(request);
    expect(res.usage).toBeUndefined();
  });

  it('keeps a partial count rather than dropping it', async () => {
    respondWith(
      JSON.stringify({
        message: { role: 'assistant', content: 'hi' },
        done: true,
        eval_count: 12,
      }),
      false,
    );

    const provider = createOllamaProvider({ model: 'test' });
    const res = await provider.send(request);
    expect(res.usage).toEqual({ outputTokens: 12 });
  });
});
