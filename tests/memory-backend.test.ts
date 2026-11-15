import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { summariseMessages } from '../src/agent/summarise.ts';
import { loadConfig, saveConfig } from '../src/config/load.ts';
import { ConfigSchema, McpServerSchema } from '../src/config/schema.ts';
import { closeDb, getDb } from '../src/db/index.ts';
import type { ConnectedMcpServer } from '../src/mcp/client.ts';
import { createMcpManager } from '../src/mcp/manager.ts';
import {
  memorySystemPrompt,
  resolveMemoryBackend,
  saveTurnMemory,
  setMemoryMcpManager,
} from '../src/memory/backend.ts';
import { countMemories, recentMemories } from '../src/memory/store.ts';
import { forgetTool, recallTool, rememberTool } from '../src/tools/memory.ts';
import type { Provider, ProviderRequest } from '../src/types/messages.ts';

let home: string;
let previousHome: string | undefined;
const session = { id: 'bot:42', scope: 'telegram' as const };
const memoryId = 'c35521f2-807c-4d0d-af49-f283ef817a46';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'asterisk-memory-backend-'));
  previousHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
  setMemoryMcpManager(undefined);
  saveConfig(ConfigSchema.parse({}));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMemoryMcpManager(undefined);
  closeDb();
  if (previousHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function configure(memory: Record<string, unknown>): void {
  saveConfig(ConfigSchema.parse({ memory }));
}

function fakeManager(names = ['store_memory', 'search_memory', 'recall_context', 'forget']) {
  const client = new Client({ name: 'fake-memory', version: '1' });
  const callTool = vi.spyOn(client, 'callTool').mockImplementation(async ({ name }) => {
    const text =
      name === 'recall_context'
        ? 'The user prefers concise replies.'
        : name === 'search_memory'
          ? JSON.stringify({ count: 1, results: [{ id: memoryId, content: 'Concise replies.' }] })
          : JSON.stringify({ id: memoryId });
    return { content: [{ type: 'text', text }] };
  });
  const server: ConnectedMcpServer = {
    config: McpServerSchema.parse({ name: 'engram', transport: 'stdio', command: 'unused' }),
    client,
    remoteTools: names.map((name) => ({
      name,
      inputSchema: { type: 'object', properties: { source: {}, sessionId: {} } },
    })),
    ensureConnected: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const manager = { servers: [server] };
  const debug = vi.fn();
  setMemoryMcpManager(manager, debug);
  return { manager, server, callTool, debug };
}

function recordingProvider(text = 'Done.'): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      name: 'fake',
      async send(request) {
        requests.push({ ...request, messages: structuredClone(request.messages) });
        return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
      },
    },
  };
}

async function flushSaves(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('memory backend resolution', () => {
  it('defaults to auto recall and save with the default MCP server', () => {
    expect(ConfigSchema.parse({}).memory).toEqual({
      backend: 'auto',
      mcpServer: 'engram',
      autoRecall: true,
      autoSave: true,
    });
  });

  it('auto selects a connected server with both required tools', () => {
    const { server } = fakeManager(['store_memory', 'search_memory']);
    expect(resolveMemoryBackend()).toEqual({ kind: 'mcp', server });
  });

  it.each([{ tools: [] }, { tools: ['store_memory'] }, { tools: ['search_memory'] }])(
    'auto falls back without both tools: $tools',
    ({ tools }) => {
      fakeManager(tools);
      expect(resolveMemoryBackend().kind).toBe('local');
    },
  );

  it('uses the configured server name and follows connection changes', () => {
    const { server, manager } = fakeManager();
    configure({ mcpServer: 'my-memory' });
    expect(resolveMemoryBackend().kind).toBe('local');
    server.config.name = 'my-memory';
    expect(resolveMemoryBackend().kind).toBe('mcp');
    manager.servers = [];
    expect(resolveMemoryBackend().kind).toBe('local');
  });

  it('forced MCP falls back locally and logs the reason', () => {
    const { manager, debug } = fakeManager(['search_memory']);
    configure({ backend: 'mcp' });
    expect(resolveMemoryBackend().kind).toBe('local');
    expect(debug).toHaveBeenLastCalledWith(
      expect.stringContaining('does not expose store_memory and search_memory'),
    );
    manager.servers = [];
    expect(resolveMemoryBackend().kind).toBe('local');
    expect(debug).toHaveBeenLastCalledWith(expect.stringContaining('is not connected'));
  });

  it('local stays local with a usable MCP server', () => {
    fakeManager();
    configure({ backend: 'local' });
    expect(resolveMemoryBackend().kind).toBe('local');
  });

  it('the real manager registers its live server list without deferred schemas', async () => {
    const { server } = fakeManager();
    const manager = createMcpManager();
    manager.servers.push(server);
    expect(resolveMemoryBackend()).toEqual({ kind: 'mcp', server });
    await manager.shutdown();
    expect(resolveMemoryBackend().kind).toBe('local');
  });
});

describe('Remember / Recall / Forget routing', () => {
  it('stores semantic notes with exact MCP arguments and supported metadata', async () => {
    const { callTool } = fakeManager();
    const result = await runWithSession(session, () =>
      rememberTool.execute({ content: 'Use tabs.', tags: ['style'] }),
    );
    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledExactlyOnceWith(
      {
        name: 'store_memory',
        arguments: {
          content: 'Use tabs.',
          tags: ['style'],
          type: 'semantic',
          importance: 0.7,
          source: 'asterisk',
          sessionId: 'bot:42',
        },
      },
      undefined,
      undefined,
    );
    expect(countMemories(getDb())).toBe(0);
  });

  it('omits metadata that the MCP tool does not accept', async () => {
    const { server, callTool } = fakeManager();
    for (const tool of server.remoteTools) tool.inputSchema = { type: 'object', properties: {} };
    await rememberTool.execute({ content: 'Use tabs.' });
    expect(callTool.mock.calls[0]?.[0].arguments).toEqual({
      content: 'Use tabs.',
      tags: [],
      type: 'semantic',
      importance: 0.7,
    });
  });

  it('shows the full search id and passes that string to forget in ids', async () => {
    const { callTool } = fakeManager();
    const result = await recallTool.execute({ query: 'style', limit: 4 });
    expect(result.output).toContain(memoryId);
    expect(callTool.mock.calls[0]?.[0]).toEqual({
      name: 'search_memory',
      arguments: { query: 'style', topK: 4 },
    });
    expect((await forgetTool.execute({ id: memoryId })).isError).toBe(false);
    expect(callTool.mock.calls[1]?.[0]).toEqual({ name: 'forget', arguments: { ids: [memoryId] } });
  });

  it('uses local tools when pinned local, including numeric deletion', async () => {
    const { callTool } = fakeManager();
    configure({ backend: 'local' });
    await rememberTool.execute({ content: 'Use tabs.' });
    expect((await recallTool.execute({ query: 'tabs' })).output).toContain('#1');
    expect((await forgetTool.execute({ id: 1 })).output).toContain('forgot #1: Use tabs.');
    expect(callTool).not.toHaveBeenCalled();
    expect(countMemories(getDb())).toBe(0);
  });
});

describe('automatic memory in the shared agent loop', () => {
  it('injects bounded notes only in this turn and never in history', async () => {
    configure({ autoSave: false });
    const { callTool } = fakeManager();
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'remembered context '.repeat(200) }],
    });
    const { provider, requests } = recordingProvider();
    const state = createAgentState();
    await runAgentTurn(provider, state, 'What did we decide?', { session });
    const first = requests[0];
    // The block rides on this turn's user message, never in the system prompt,
    // so the cached prefix (system + earlier history) stays byte-identical.
    expect(first?.system).not.toContain('<memory>');
    const injected = JSON.stringify(first?.messages.at(-1)?.content[0]);
    expect(injected).toContain('<memory>\\nRecalled notes, possibly stale.');
    const text = (first?.messages.at(-1)?.content[0] as { text?: string } | undefined)?.text ?? '';
    const block = text.match(/<memory>[\s\S]*<\/memory>/)?.[0] ?? '';
    expect(block.length).toBe(1500);
    expect(callTool.mock.calls[0]?.[0]).toEqual({
      name: 'recall_context',
      arguments: { query: 'What did we decide?', maxTokens: 375 },
    });
    expect(JSON.stringify(state.history)).not.toContain('remembered context');
    callTool.mockResolvedValueOnce({ content: [] });
    await runAgentTurn(provider, state, 'Next question', { session });
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('<memory>');
    expect(JSON.stringify(state.history)).not.toContain('<memory>');
  });

  it('falls back to search_memory when recall_context is absent', async () => {
    configure({ autoSave: false });
    const { callTool } = fakeManager(['store_memory', 'search_memory']);
    const { provider, requests } = recordingProvider();
    await runAgentTurn(provider, createAgentState(), 'style', { session });
    expect(callTool.mock.calls[0]?.[0]).toEqual({
      name: 'search_memory',
      arguments: { query: 'style', topK: 5 },
    });
    expect(JSON.stringify(requests[0]?.messages)).toContain(memoryId);
  });

  it.each(['No relevant memories found.', '{"count":0,"results":[]}', '   '])(
    'injects nothing for empty recall %s',
    async (text) => {
      configure({ autoSave: false });
      const { callTool } = fakeManager();
      callTool.mockResolvedValueOnce({ content: [{ type: 'text', text }] });
      const { provider, requests } = recordingProvider();
      expect((await runAgentTurn(provider, createAgentState(), 'style', { session })).reason).toBe(
        'end-turn',
      );
      expect(JSON.stringify(requests[0]?.messages)).not.toContain('<memory>');
    },
  );

  it.each(['reject', 'isError'])('recall %s does not fail a turn', async (failure) => {
    configure({ autoSave: false });
    const { callTool, debug } = fakeManager();
    if (failure === 'reject') callTool.mockRejectedValueOnce(new Error('offline'));
    else
      callTool.mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'offline' }],
      });
    const { provider, requests } = recordingProvider();
    expect((await runAgentTurn(provider, createAgentState(), 'style', { session })).finalText).toBe(
      'Done.',
    );
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('<memory>');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('auto-recall failed'));
  });

  it('times out even if connecting to the server ignores cancellation', async () => {
    vi.useFakeTimers();
    configure({ autoSave: false });
    const { server, callTool, debug } = fakeManager();
    vi.mocked(server.ensureConnected).mockImplementationOnce(() => new Promise(() => {}));
    const { provider, requests } = recordingProvider();
    const turn = runAgentTurn(provider, createAgentState(), 'style', { session });
    await vi.advanceTimersByTimeAsync(2999);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await turn).reason).toBe('end-turn');
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('<memory>');
    expect(callTool).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('3s timeout'));
  });

  it.each(['repl', 'telegram'] as const)(
    'saves one episodic exchange per %s turn',
    async (scope) => {
      configure({ autoRecall: false });
      const { callTool } = fakeManager();
      const { provider } = recordingProvider('R'.repeat(1300));
      await runAgentTurn(provider, createAgentState(), 'U'.repeat(700), {
        session: { id: `${scope}:42`, scope },
      });
      await flushSaves();
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(callTool.mock.calls[0]?.[0]).toEqual({
        name: 'store_memory',
        arguments: {
          content: `User: ${'U'.repeat(600)}\nAssistant: ${'R'.repeat(1200)}`,
          tags: ['session', scope],
          type: 'episodic',
          importance: 0.3,
          source: 'asterisk',
          sessionId: `${scope}:42`,
        },
      });
    },
  );

  it('saves only the final reply once across tool-use rounds', async () => {
    configure({ autoRecall: false });
    const { callTool } = fakeManager();
    let round = 0;
    const provider: Provider = {
      name: 'fake',
      async send() {
        if (round++ === 0) {
          return {
            content: [
              { type: 'text', text: 'Checking memory.' },
              { type: 'tool_use', id: 'recall-1', name: 'Recall', input: { query: 'style' } },
            ],
            stopReason: 'tool_use',
          };
        }
        return {
          content: [{ type: 'text', text: 'Use concise replies.' }],
          stopReason: 'end_turn',
        };
      },
    };
    await runAgentTurn(provider, createAgentState(), 'What is my style?', { session });
    await flushSaves();
    const stores = callTool.mock.calls.filter(([input]) => input.name === 'store_memory');
    expect(stores).toHaveLength(1);
    expect(stores[0]?.[0].arguments?.['content']).toBe(
      'User: What is my style?\nAssistant: Use concise replies.',
    );
  });

  it('does not wait for a background save', async () => {
    configure({ autoRecall: false });
    const { callTool } = fakeManager();
    let finish: ((value: { content: [] }) => void) | undefined;
    callTool.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { provider } = recordingProvider();
    expect((await runAgentTurn(provider, createAgentState(), 'hello', { session })).reason).toBe(
      'end-turn',
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    finish?.({ content: [] });
    await flushSaves();
  });

  it('logs save errors without failing the reply', async () => {
    configure({ autoRecall: false });
    const { callTool, debug } = fakeManager();
    callTool.mockRejectedValueOnce(new Error('offline'));
    const { provider } = recordingProvider();
    expect((await runAgentTurn(provider, createAgentState(), 'hello', { session })).reason).toBe(
      'end-turn',
    );
    await flushSaves();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('auto-save failed'));
  });

  it.each(['sub-agent', 'scheduled'] as const)(
    'skips automatic recall, saves and summaries for %s',
    async (scope) => {
      const { callTool } = fakeManager();
      const { provider } = recordingProvider();
      await runAgentTurn(provider, createAgentState(), 'hello', {
        session: { id: 'child', scope },
      });
      await runWithSession({ id: 'child', scope }, () =>
        summariseMessages(
          [{ role: 'user', content: [{ type: 'text', text: 'previous turn' }] }],
          provider,
        ),
      );
      await flushSaves();
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  it('skips slash commands, empty final replies, disabled saves and interrupted turns', async () => {
    configure({ autoRecall: false });
    const { callTool } = fakeManager();
    const { provider } = recordingProvider();
    for (const command of ['/clear', '/reset', ' /help@my_bot']) {
      await runAgentTurn(provider, createAgentState(), command, { session });
    }
    await runWithSession(session, async () => saveTurnMemory('hello', '  '));
    await runAgentTurn(provider, createAgentState(), 'cancelled', {
      session,
      signal: AbortSignal.abort(),
    });
    configure({ autoRecall: false, autoSave: false });
    await runAgentTurn(provider, createAgentState(), 'hello', { session });
    await flushSaves();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('stores an existing compaction summary as episodic without another model call', async () => {
    const { callTool } = fakeManager();
    const { provider, requests } = recordingProvider('We chose the smaller change.');
    const summary = await runWithSession(session, () =>
      summariseMessages(
        [{ role: 'user', content: [{ type: 'text', text: 'We chose the smaller change.' }] }],
        provider,
      ),
    );
    await flushSaves();
    expect(summary).toBe('We chose the smaller change.');
    expect(requests).toHaveLength(1);
    expect(callTool.mock.calls[0]?.[0]).toEqual({
      name: 'store_memory',
      arguments: {
        content: summary,
        tags: ['session-summary'],
        type: 'episodic',
        importance: 0.6,
        source: 'asterisk',
        sessionId: 'bot:42',
      },
    });
  });

  it('automatically recalls and saves through the local fallback', async () => {
    await rememberTool.execute({ content: 'Friday is release day.' });
    const { provider, requests } = recordingProvider();
    await runAgentTurn(provider, createAgentState(), 'Friday', { session });
    expect(JSON.stringify(requests[0]?.messages)).toContain('#1: Friday is release day.');
    expect(requests[0]?.system).not.toContain('<memory>');
    expect(recentMemories(getDb()).find((m) => m.tags.includes('session'))?.content).toBe(
      'User: Friday\nAssistant: Done.',
    );
  });

  it('only promises automatic recall when enabled', () => {
    expect(memorySystemPrompt()).toContain('recalled automatically each turn');
    configure({ autoRecall: false });
    expect(memorySystemPrompt()).toContain('Remember and Recall');
    expect(memorySystemPrompt()).not.toContain('recalled automatically');
    expect(loadConfig().config.memory.autoRecall).toBe(false);
  });
});

describe('secret filtering', () => {
  const secrets = [
    `sk-${'a'.repeat(24)}`,
    `ghp_${'a'.repeat(36)}`,
    `xoxb-${'a'.repeat(12)}`,
    `AIza${'a'.repeat(35)}`,
    `AKIA${'A'.repeat(16)}`,
  ];

  it.each(['mcp', 'local'])('rejects Remember secrets with %s storage', async (backend) => {
    configure({ backend });
    const { callTool } = fakeManager();
    for (const secret of secrets) {
      expect((await rememberTool.execute({ content: `The key is ${secret}` })).isError).toBe(true);
      expect((await rememberTool.execute({ content: 'A note', tags: [secret] })).isError).toBe(
        true,
      );
    }
    expect(countMemories(getDb())).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('checks complete exchanges before truncating, including assistant text', async () => {
    configure({ autoRecall: false });
    const { callTool } = fakeManager();
    const secret = secrets[0] ?? '';
    const { provider } = recordingProvider();
    await runAgentTurn(provider, createAgentState(), `${'u'.repeat(700)} ${secret}`, { session });
    await runAgentTurn(
      recordingProvider(`${'r'.repeat(1300)} ${secret}`).provider,
      createAgentState(),
      'hello',
      { session },
    );
    await flushSaves();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('does not send a secret to automatic recall or save a secret summary', async () => {
    const { callTool } = fakeManager();
    const text = `The key is ${secrets[0]}`;
    const { provider } = recordingProvider();
    await runAgentTurn(provider, createAgentState(), text, { session });
    await runWithSession(session, () =>
      summariseMessages(
        [{ role: 'user', content: [{ type: 'text', text }] }],
        recordingProvider(text).provider,
      ),
    );
    await flushSaves();
    expect(callTool).not.toHaveBeenCalled();
    expect(countMemories(getDb())).toBe(0);
  });
});
