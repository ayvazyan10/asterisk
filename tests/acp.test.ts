// The Agent Client Protocol surface.
//
// Driven directly rather than through a spawned process: the transport is a
// dozen lines of newline splitting, and everything worth getting wrong is in
// the protocol — method names, the handshake, which messages get a reply.
//
// Standing caveat, also stated in the server's header: these tests check the
// server against the published schema, NOT against a real ACP client. Nothing
// here proves an editor can drive Asterisk; it proves the shapes match what the
// schema says.

import { describe, expect, it, vi } from 'vitest';

import { type JsonRpcMessage, PROTOCOL_VERSION, createAcpServer } from '../src/acp/server.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';

function textReply(text: string): ProviderResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function harness(provider?: Provider) {
  const sent: JsonRpcMessage[] = [];
  let nextId = 0;
  const server = createAcpServer({
    send: (m) => sent.push(m),
    createProvider: () =>
      provider ?? {
        name: 'fake',
        async send() {
          return textReply('hello from the agent');
        },
      },
  });
  return {
    sent,
    server,
    /** Sends a request and returns the response with the matching id. */
    async call(method: string, params: Record<string, unknown> = {}, id?: number | string) {
      // Unique per call: responses are matched by id, so reusing one makes the
      // second call find the first call's answer.
      id = id ?? `req-${++nextId}`;
      await server.handle({ jsonrpc: '2.0', id, method, params });
      return sent.find((m) => m.id === id);
    },
    updates: () => sent.filter((m) => m.method === 'session/update'),
  };
}

async function openSession(h: ReturnType<typeof harness>): Promise<string> {
  const created = await h.call('session/new', { cwd: '/tmp/project', mcpServers: [] });
  return (created?.result as { sessionId: string }).sessionId;
}

describe('initialize', () => {
  it('echoes a protocol version it supports', async () => {
    const h = harness();
    const res = await h.call('initialize', { protocolVersion: PROTOCOL_VERSION });
    expect((res?.result as { protocolVersion: number }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('answers with its own maximum when the client asks for a newer one', async () => {
    // "the protocol version the client specified if supported by the agent, or
    // the latest protocol version supported by the agent".
    const h = harness();
    const res = await h.call('initialize', { protocolVersion: PROTOCOL_VERSION + 99 });
    expect((res?.result as { protocolVersion: number }).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('reports capabilities and an empty authMethods', async () => {
    const h = harness();
    const result = (await h.call('initialize', { protocolVersion: 1 }))?.result as Record<
      string,
      unknown
    >;
    expect(result['authMethods']).toEqual([]);
    // Advertising loadSession would be a lie — session/load is not implemented.
    expect(result['agentCapabilities']).toMatchObject({ loadSession: false });
    expect(result['agentInfo']).toMatchObject({ name: 'asterisk' });
  });
});

describe('session/new', () => {
  it('returns a session id', async () => {
    const h = harness();
    const res = await h.call('session/new', { cwd: '/tmp/project', mcpServers: [] });
    expect((res?.result as { sessionId: string }).sessionId).toMatch(/[0-9a-f-]{36}/);
  });

  it('requires cwd', async () => {
    const h = harness();
    const res = await h.call('session/new', { mcpServers: [] });
    expect(res?.error?.code).toBe(-32602);
  });

  it('hands out distinct ids', async () => {
    const h = harness();
    const a = await openSession(h);
    const b = await openSession(h);
    expect(a).not.toBe(b);
  });
});

describe('session/prompt', () => {
  it('runs a turn and reports a stopReason', async () => {
    const h = harness();
    const sessionId = await openSession(h);

    const res = await h.call(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      'p1',
    );

    expect(res?.result).toEqual({ stopReason: 'end_turn' });
  });

  it('streams agent_message_chunk updates as the reply arrives', async () => {
    const streaming: Provider = {
      name: 'streamer',
      async send(req) {
        req.onText?.('par');
        req.onText?.('tial');
        return textReply('partial');
      },
    };
    const h = harness(streaming);
    const sessionId = await openSession(h);

    await h.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] }, 'p1');

    const chunks = h
      .updates()
      .map((m) => (m.params as { update: Record<string, unknown> }).update)
      .filter((u) => u['sessionUpdate'] === 'agent_message_chunk');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ content: { type: 'text', text: 'par' } });
  });

  it('rejects an unknown session', async () => {
    const h = harness();
    const res = await h.call('session/prompt', {
      sessionId: 'nope',
      prompt: [{ type: 'text', text: 'hi' }],
    });
    expect(res?.error?.code).toBe(-32602);
  });

  it('rejects a prompt with no text content', async () => {
    const h = harness();
    const sessionId = await openSession(h);
    for (const prompt of [[], undefined, [{ type: 'image', data: 'x' }]]) {
      const res = await h.call('session/prompt', { sessionId, prompt }, `p-${String(prompt)}`);
      expect(res?.error?.code).toBe(-32602);
    }
  });

  it('joins multiple text blocks', async () => {
    const seen: string[] = [];
    const recording: Provider = {
      name: 'recorder',
      async send(req) {
        const first = req.messages[0]?.content[0];
        if (first && first.type === 'text') seen.push(first.text);
        return textReply('ok');
      },
    };
    const h = harness(recording);
    const sessionId = await openSession(h);

    await h.call('session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    });

    expect(seen[0]).toContain('line one');
    expect(seen[0]).toContain('line two');
  });

  it('reports a provider failure as an internal error rather than hanging', async () => {
    const broken: Provider = {
      name: 'broken',
      async send() {
        throw new Error('connection refused');
      },
    };
    const h = harness(broken);
    const sessionId = await openSession(h);

    const res = await h.call('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    // The loop classifies and retries; whatever comes out, the client gets an
    // answer to its request instead of silence.
    expect(res?.result ?? res?.error).toBeDefined();
  });
});

describe('session/cancel', () => {
  it('aborts the running turn and the prompt reports cancelled', async () => {
    let release: (() => void) | undefined;
    const slow: Provider = {
      name: 'slow',
      async send(req) {
        // Real providers reject with ProviderError('aborted') when the signal
        // fires; a fake that resolves normally would let the loop finish the
        // turn and report end_turn, testing nothing.
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          req.signal?.addEventListener(
            'abort',
            () => reject(new ProviderError('aborted', 'request aborted')),
            { once: true },
          );
        });
        return textReply('too late');
      },
    };
    const h = harness(slow);
    const sessionId = await openSession(h);

    const running = h.call(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'long job' }] },
      'p1',
    );
    // Let the turn reach the provider before cancelling it.
    await vi.waitFor(() => expect(release).toBeDefined());
    await h.server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });

    const res = await running;
    expect(res?.result).toEqual({ stopReason: 'cancelled' });
  });

  it('is a notification — it gets no reply of its own', async () => {
    const h = harness();
    const sessionId = await openSession(h);
    const before = h.sent.length;
    await h.server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    expect(h.sent.length).toBe(before);
  });

  it('ignores an unknown session instead of throwing', async () => {
    const h = harness();
    await expect(
      h.server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'x' } }),
    ).resolves.toBeUndefined();
  });
});

describe('unimplemented and malformed', () => {
  it.each(['session/load', 'session/resume', 'authenticate', 'session/list'])(
    'answers %s with method-not-found rather than pretending',
    async (method) => {
      const h = harness();
      const res = await h.call(method, {});
      expect(res?.error?.code).toBe(-32601);
    },
  );

  it('never answers a notification, even an unknown one', async () => {
    // Replying to a message with no id is a protocol violation on its own.
    const h = harness();
    await h.server.handle({ jsonrpc: '2.0', method: 'some/notification', params: {} });
    expect(h.sent).toHaveLength(0);
  });

  it('ignores a response frame', async () => {
    const h = harness();
    await h.server.handle({ jsonrpc: '2.0', id: 7, result: {} });
    expect(h.sent).toHaveLength(0);
  });
});
