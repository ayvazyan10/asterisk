import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
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
