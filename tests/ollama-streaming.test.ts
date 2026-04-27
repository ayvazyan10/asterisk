// Streaming integration test for the Ollama provider — mocks global fetch
// to deliver an NDJSON chat response one chunk at a time and asserts that
// the provider invokes onText per delta while still returning the fully
// assembled message (including any tool_calls in the last frame).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOllamaProvider } from '../src/providers/ollama.ts';
import type { TextBlock, ToolUseBlock } from '../src/types/messages.ts';

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= lines.length) {
        ctrl.close();
        return;
      }
      const line = lines[i++] ?? '';
      ctrl.enqueue(enc.encode(`${line}\n`));
    },
  });
}

const realFetch = globalThis.fetch;

describe('Ollama streaming', () => {
  let lastBody: string | null = null;

  beforeEach(() => {
    lastBody = null;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('forwards per-chunk deltas to onText and assembles full content', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastBody = String(init?.body ?? '');
      const stream = ndjsonStream([
        JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: ', ' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: 'world!' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
      ]);
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const deltas: string[] = [];
    const r = await provider.send({
      system: 'sys',
      messages: [],
      tools: [],
      onText: (d) => deltas.push(d),
    });

    expect(deltas.join('')).toBe('Hello, world!');
    expect(deltas.length).toBe(3); // one per non-empty chunk
    expect(JSON.parse(lastBody!)).toMatchObject({ stream: true });
    expect(r.content).toEqual([{ type: 'text', text: 'Hello, world!' }]);
    expect(r.stopReason).toBe('end_turn');
  });

  it('hides chain-of-thought tokens from onText but keeps content clean', async () => {
    globalThis.fetch = (async () => {
      const stream = ndjsonStream([
        JSON.stringify({ message: { role: 'assistant', content: '<think>hmm' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: ' planning</think>' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: 'Done.' }, done: true }),
      ]);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const visible: string[] = [];
    const r = await provider.send({
      system: 's',
      messages: [],
      tools: [],
      onText: (d) => visible.push(d),
    });

    const seen = visible.join('');
    expect(seen).not.toContain('<think>');
    expect(seen).not.toContain('</think>');
    expect(seen).not.toContain('hmm');
    expect(seen).toContain('Done');
    // Final blocks: stripThinkTags applies to aggregated content too.
    expect((r.content[0] as TextBlock).text).toBe('Done.');
  });

  it('captures tool_calls from the final stream frame', async () => {
    globalThis.fetch = (async () => {
      const stream = ndjsonStream([
        JSON.stringify({ message: { role: 'assistant', content: 'thinking aloud ' }, done: false }),
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'WebFetch', arguments: { url: 'https://x' } } }],
          },
          done: true,
        }),
      ]);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const r = await provider.send({
      system: 's',
      messages: [],
      tools: [],
      onText: () => {},
    });
    const toolBlock = r.content.find((b) => b.type === 'tool_use') as ToolUseBlock | undefined;
    expect(toolBlock).toBeTruthy();
    expect(toolBlock?.name).toBe('WebFetch');
    expect(toolBlock?.input).toEqual({ url: 'https://x' });
    expect(r.stopReason).toBe('tool_use');
  });

  it('falls back to non-streaming when no onText is provided', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lastBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({ message: { role: 'assistant', content: 'plain' }, done: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const r = await provider.send({ system: 's', messages: [], tools: [] });
    expect(JSON.parse(lastBody!)).toMatchObject({ stream: false });
    expect((r.content[0] as TextBlock).text).toBe('plain');
  });
});
