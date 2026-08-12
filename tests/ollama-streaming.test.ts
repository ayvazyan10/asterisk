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
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
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
        JSON.stringify({
          message: { role: 'assistant', content: ' planning</think>' },
          done: false,
        }),
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

  it('surfaces <think> content via onThinking when the caller provides it', async () => {
    // The exact repro of the user's "Asterisk hangs while clocal shows
    // progress" bug: qwen3.5-style models emit a long <think> block before
    // any visible text. onThinking lets the UI show "thinking · N chars"
    // instead of looking like the agent crashed.
    globalThis.fetch = (async () => {
      const stream = ndjsonStream([
        JSON.stringify({ message: { role: 'assistant', content: '<think>let me' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: ' think about it' }, done: false }),
        JSON.stringify({
          message: { role: 'assistant', content: ' carefully</think>' },
          done: false,
        }),
        JSON.stringify({ message: { role: 'assistant', content: 'final answer' }, done: true }),
      ]);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const visible: string[] = [];
    const thinking: string[] = [];
    await provider.send({
      system: 's',
      messages: [],
      tools: [],
      onText: (d) => visible.push(d),
      onThinking: (d) => thinking.push(d),
    });

    const thoughtSeen = thinking.join('');
    expect(thoughtSeen).toContain('let me');
    expect(thoughtSeen).toContain('think about it');
    expect(thoughtSeen).toContain('carefully');
    expect(thoughtSeen).not.toContain('<think>');
    expect(thoughtSeen).not.toContain('</think>');
    expect(thoughtSeen).not.toContain('final answer');

    const visibleSeen = visible.join('');
    expect(visibleSeen).not.toContain('let me');
    expect(visibleSeen).toContain('final answer');
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

  it('strips orphan </think> without a preceding <think> (omnicoder-style)', async () => {
    // Models like omnicoder have the <think> tag injected by their template
    // outside the content stream. The content starts with reasoning text and
    // eventually emits </think> followed by the real answer.
    globalThis.fetch = (async () => {
      const stream = ndjsonStream([
        // Reasoning + close tag in same chunk — filter catches it.
        JSON.stringify({
          message: { role: 'assistant', content: 'reasoning about task</think>' },
          done: false,
        }),
        JSON.stringify({
          message: { role: 'assistant', content: 'The answer is 42.' },
          done: false,
        }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
      ]);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const visible: string[] = [];
    const thinking: string[] = [];
    await provider.send({
      system: 's',
      messages: [],
      tools: [],
      onText: (d) => visible.push(d),
      onThinking: (d) => thinking.push(d),
    });

    const visibleText = visible.join('');
    expect(visibleText).not.toContain('</think>');
    expect(visibleText).not.toContain('reasoning');
    expect(visibleText).toContain('The answer is 42.');

    const thoughtText = thinking.join('');
    expect(thoughtText).toContain('reasoning');
  });

  it('strips bare </think> tag arriving as a separate chunk', async () => {
    globalThis.fetch = (async () => {
      const stream = ndjsonStream([
        // Pre-emitted reasoning leaks in streaming (unavoidable), but the
        // </think> tag itself must never appear in visible output.
        JSON.stringify({ message: { role: 'assistant', content: 'preamble' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '</think>' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: 'answer' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
      ]);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({ baseUrl: 'http://x', model: 'm' });
    const visible: string[] = [];
    await provider.send({
      system: 's',
      messages: [],
      tools: [],
      onText: (d) => visible.push(d),
    });

    const visibleText = visible.join('');
    expect(visibleText).not.toContain('</think>');
    expect(visibleText).toContain('answer');
  });

  it('aborts on idle timeout when no chunks arrive', async () => {
    globalThis.fetch = (async () => {
      // Stream that sends one chunk then stalls forever.
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const enc = new TextEncoder();
          ctrl.enqueue(
            enc.encode(
              JSON.stringify({ message: { role: 'assistant', content: 'start' }, done: false }) +
                '\n',
            ),
          );
          // Never sends more data — triggers idle timeout.
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({
      baseUrl: 'http://x',
      model: 'm',
      modelIdleTimeoutMs: 200,
      modelTimeoutMs: 10_000,
    });
    await expect(
      provider.send({ system: 's', messages: [], tools: [], onText: () => {} }),
    ).rejects.toThrow(/aborted|idle timeout/i);
  });

  it('aborts on total model timeout', async () => {
    globalThis.fetch = (async () => {
      // Stream that drips data slowly — exceeds total timeout.
      let interval: ReturnType<typeof setInterval>;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          const enc = new TextEncoder();
          interval = setInterval(() => {
            try {
              ctrl.enqueue(
                enc.encode(
                  JSON.stringify({ message: { role: 'assistant', content: '.' }, done: false }) +
                    '\n',
                ),
              );
            } catch {
              clearInterval(interval);
            }
          }, 50);
        },
        cancel() {
          clearInterval(interval!);
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = createOllamaProvider({
      baseUrl: 'http://x',
      model: 'm',
      modelIdleTimeoutMs: 60_000,
      modelTimeoutMs: 300,
    });
    await expect(
      provider.send({ system: 's', messages: [], tools: [], onText: () => {} }),
    ).rejects.toThrow(/aborted|timed out/i);
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
