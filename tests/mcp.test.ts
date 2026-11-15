import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../src/config/load.ts';
import { ConfigSchema, type McpServerConfig } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import { asLocalTool, connectMcpServer } from '../src/mcp/client.ts';
import { createMcpManager } from '../src/mcp/manager.ts';
import { defined } from './helpers.ts';

describe('McpManager', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-mcp-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('reload returns empty when no servers configured', async () => {
    const m = createMcpManager();
    const result = await m.reload();
    expect(result.connected).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(m.tools).toEqual([]);
    await m.shutdown();
  });

  it('reload reports connect failures without throwing', async () => {
    const cfg = ConfigSchema.parse({
      mcpServers: [
        {
          name: 'bogus',
          transport: 'stdio',
          command: '/does/not/exist/asterisk-mcp-bogus-bin',
          args: [],
          env: {},
          enabled: true,
        },
      ],
    });
    saveConfig(cfg);

    const m = createMcpManager();
    const result = await m.reload();
    expect(result.connected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe('bogus');
    expect(m.tools).toEqual([]);
    await m.shutdown();
  });

  it('skips disabled servers entirely', async () => {
    const cfg = ConfigSchema.parse({
      mcpServers: [
        {
          name: 'off',
          transport: 'stdio',
          command: '/no',
          args: [],
          env: {},
          enabled: false,
        },
      ],
    });
    saveConfig(cfg);
    const m = createMcpManager();
    const result = await m.reload();
    expect(result.connected).toEqual([]);
    expect(result.failed).toEqual([]);
    await m.shutdown();
  });
});

describe('connectMcpServer tool discovery', () => {
  const config: McpServerConfig = {
    name: 'fake',
    transport: 'stdio',
    command: 'fake-server',
    args: [],
    env: {},
    enabled: true,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects with zero tools when the server reports no tools capability', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue({});
    const listTools = vi.spyOn(Client.prototype, 'listTools');
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);

    const connected = await connectMcpServer(config);

    expect(connected.remoteTools).toEqual([]);
    expect(listTools).not.toHaveBeenCalled();
    await connected.close();
  });

  it('closes the client and rethrows when listTools fails', async () => {
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue({ tools: {} });
    vi.spyOn(Client.prototype, 'listTools').mockRejectedValue(new Error('boom'));
    const close = vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);

    await expect(connectMcpServer(config)).rejects.toThrow('boom');
    expect(close).toHaveBeenCalled();
  });

  it('passes the abort signal through to callTool', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const server = {
      config,
      client: { callTool },
      ensureConnected: async () => {},
    } as unknown as Parameters<typeof asLocalTool>[0];
    const tool = asLocalTool(server, { name: 'slow', inputSchema: { type: 'object' } });
    const ctrl = new AbortController();

    await tool.execute({}, { signal: ctrl.signal });

    expect(callTool.mock.calls[0]?.[2]).toEqual({ signal: ctrl.signal });
  });
});

describe('MCP transport lifecycle', () => {
  const config: McpServerConfig = {
    name: 'fake',
    transport: 'stdio',
    command: 'fake-server',
    args: [],
    env: {},
    enabled: true,
  };
  const remote = { name: 'echo', inputSchema: { type: 'object' as const, properties: {} } };
  let home: string;
  let transports: StdioClientTransport[];
  let startGates: Array<Promise<void> | undefined>;
  let failNext: boolean;
  let now: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-mcp-lifecycle-'));
    vi.stubEnv('ASTERISK_HOME', home);
    transports = [];
    startGates = [];
    failNext = false;
    now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Exercise the real SDK client and its transport callbacks without spawning
    // a process or using a socket. Each fresh transport speaks the MCP handshake.
    vi.spyOn(StdioClientTransport.prototype, 'start').mockImplementation(async function (
      this: StdioClientTransport,
    ) {
      const index = transports.push(this) - 1;
      if (failNext) {
        failNext = false;
        throw new Error('server unavailable');
      }
      await startGates[index];
    });
    vi.spyOn(StdioClientTransport.prototype, 'close').mockImplementation(async function (
      this: StdioClientTransport,
    ) {
      this.onclose?.();
    });
    vi.spyOn(StdioClientTransport.prototype, 'send').mockImplementation(async function (
      this: StdioClientTransport,
      message,
    ) {
      if (!('method' in message) || !('id' in message)) return;
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: 'fake', version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [remote] }
            : { content: [{ type: 'text', text: 'ok' }] };
      this.onmessage?.({ jsonrpc: '2.0', id: message.id, result });
    });
  });

  afterEach(async () => {
    for (const transport of transports) await transport.close();
    closeDb();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function gate() {
    let resolve = (): void => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it.each(['close', 'error'] as const)('reconnects lazily after a transport %s', async (event) => {
    const server = await connectMcpServer(config);
    const tool = asLocalTool(server, remote);
    await expect(tool.execute({})).resolves.toEqual({ output: 'ok', isError: false });
    const transport = defined(transports[0]);
    if (event === 'close') transport.onclose?.();
    else transport.onerror?.(new Error('pipe broken'));
    expect(transports).toHaveLength(1);

    await expect(tool.execute({})).resolves.toEqual({ output: 'ok', isError: false });
    expect(transports).toHaveLength(2);
    await tool.execute({});
    expect(transports).toHaveLength(2);
    await server.close();
  });

  it('returns a tool error on reconnect failure and retries only after the backoff', async () => {
    const server = await connectMcpServer(config);
    const tool = asLocalTool(server, remote);
    defined(transports[0]).onclose?.();
    failNext = true;

    await expect(tool.execute({})).resolves.toEqual({
      output: 'mcp call failed: MCP server fake reconnect failed: server unavailable',
      isError: true,
    });
    expect(transports).toHaveLength(2);
    now += 29_999;
    await expect(tool.execute({})).resolves.toEqual({
      output: 'mcp call failed: MCP server fake disconnected; retry in 1s',
      isError: true,
    });
    expect(transports).toHaveLength(2);
    now += 1;
    await expect(tool.execute({})).resolves.toEqual({ output: 'ok', isError: false });
    expect(transports).toHaveLength(3);
    // A successful reconnect followed by another crash also respects the cap.
    defined(transports[2]).onclose?.();
    expect((await tool.execute({})).isError).toBe(true);
    expect(transports).toHaveLength(3);
    await server.close();
  });

  it('shares a reconnect attempt across concurrent tool calls', async () => {
    const server = await connectMcpServer(config);
    const tool = asLocalTool(server, remote);
    defined(transports[0]).onclose?.();
    const release = gate();
    startGates[1] = release.promise;
    const first = tool.execute({});
    const second = tool.execute({});
    try {
      await vi.waitFor(() => expect(transports).toHaveLength(2));
    } finally {
      release.resolve();
    }
    expect(await Promise.all([first, second])).toEqual([
      { output: 'ok', isError: false },
      { output: 'ok', isError: false },
    ]);
    expect(transports).toHaveLength(2);
    await server.close();
  });

  it('does not reconnect after an intentional close', async () => {
    const server = await connectMcpServer(config);
    await server.close();
    await expect(asLocalTool(server, remote).execute({})).resolves.toEqual({
      output: 'mcp call failed: MCP server fake is closed',
      isError: true,
    });
    expect(transports).toHaveLength(1);
  });

  it('connects servers concurrently and publishes each ready server without waiting for the other', async () => {
    saveConfig(ConfigSchema.parse({ mcpServers: [config, { ...config, name: 'second' }] }));
    const first = gate();
    const second = gate();
    startGates = [first.promise, second.promise];
    const manager = createMcpManager();
    const reloading = manager.reload();
    try {
      await vi.waitFor(() => expect(transports).toHaveLength(2));
      second.resolve();
      await vi.waitFor(() =>
        expect(manager.tools.map((tool) => tool.name)).toEqual(['second__echo']),
      );
    } finally {
      first.resolve();
      second.resolve();
      await reloading;
    }
    expect((await reloading).connected).toEqual(['second (1 tools)', 'fake (1 tools)']);
    expect(manager.servers).toHaveLength(2);
    await manager.shutdown();
  });

  it('closes a background connection that completes after shutdown', async () => {
    saveConfig(ConfigSchema.parse({ mcpServers: [config] }));
    const release = gate();
    startGates = [release.promise];
    const manager = createMcpManager();
    const reloading = manager.reload();
    try {
      await vi.waitFor(() => expect(transports).toHaveLength(1));
      await manager.shutdown();
    } finally {
      release.resolve();
      await reloading;
    }
    expect(manager.servers).toEqual([]);
    expect(manager.tools).toEqual([]);
    expect(StdioClientTransport.prototype.close).toHaveBeenCalled();
  });
});
