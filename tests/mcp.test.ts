import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveConfig } from '../src/config/load.ts';
import { ConfigSchema, type McpServerConfig } from '../src/config/schema.ts';
import { connectMcpServer } from '../src/mcp/client.ts';
import { createMcpManager } from '../src/mcp/manager.ts';

describe('McpManager', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-mcp-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
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
});
