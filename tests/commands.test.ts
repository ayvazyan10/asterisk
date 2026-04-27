import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agent/loop.ts';
import { COMMANDS, lookupCommand } from '../src/commands/registry.ts';
import { createOllamaProvider } from '../src/providers/ollama.ts';
import type { Provider } from '../src/types/messages.ts';
import type { McpManager } from '../src/mcp/manager.ts';

function fakeMcp(): McpManager {
  return {
    servers: [],
    tools: [],
    async reload() {
      return { connected: [], failed: [] };
    },
    async shutdown() {},
  };
}

function ctx(provider: Provider) {
  const state = createAgentState();
  let exited = false;
  let cleared = false;
  return {
    state,
    provider,
    setProvider: () => {},
    clearHistory: () => {
      cleared = true;
      state.history.length = 0;
    },
    exit: () => {
      exited = true;
    },
    mcp: fakeMcp(),
    flags: () => ({ exited, cleared }),
  };
}

describe('command registry', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-cmd-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('exposes the expected slash commands', () => {
    const names = COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        '/clear',
        '/config',
        '/help',
        '/hooks',
        '/mcp',
        '/model',
        '/plan',
        '/provider',
        '/quit',
        '/reset',
        '/rules',
        '/skill',
        '/skills',
        '/soul',
        '/status',
        '/tasks',
        '/tools',
      ].sort(),
    );
  });

  it('lookupCommand parses name and args', () => {
    const r = lookupCommand('/model qwen3.5:9b');
    expect(r?.command.name).toBe('/model');
    expect(r?.args).toBe('qwen3.5:9b');
    expect(lookupCommand('plain text')).toBeNull();
    expect(lookupCommand('/notreal')).toBeNull();
  });

  it('/help with no args lists all commands', async () => {
    const c = ctx(createOllamaProvider());
    const out = (await COMMANDS.find((c2) => c2.name === '/help')!.execute(c, '')) as string;
    expect(out).toContain('/help');
    expect(out).toContain('/mcp');
    expect(out).toContain('/model');
  });

  it('/help model returns details', async () => {
    const c = ctx(createOllamaProvider());
    const out = (await COMMANDS.find((c2) => c2.name === '/help')!.execute(c, 'model')) as string;
    expect(out).toMatch(/\/model/);
  });

  it('/clear clears history through the context mutator', async () => {
    const c = ctx(createOllamaProvider());
    c.state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(c.state.history).toHaveLength(1);
    await COMMANDS.find((c2) => c2.name === '/clear')!.execute(c, '');
    expect(c.state.history).toHaveLength(0);
    expect(c.flags().cleared).toBe(true);
  });

  it('/quit calls exit()', async () => {
    const c = ctx(createOllamaProvider());
    const result = await COMMANDS.find((c2) => c2.name === '/quit')!.execute(c, '');
    expect(result).toBeNull();
    expect(c.flags().exited).toBe(true);
  });

  it('/tools lists registered tools', async () => {
    const c = ctx(createOllamaProvider());
    const out = (await COMMANDS.find((c2) => c2.name === '/tools')!.execute(c, '')) as string;
    expect(out).toContain('Bash');
    expect(out).toContain('Read');
    expect(out).toContain('Glob');
  });

  it('/mcp list reports empty text when no servers configured', async () => {
    const c = ctx(createOllamaProvider());
    const out = await COMMANDS.find((c2) => c2.name === '/mcp')!.execute(c, 'list');
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(/No MCP servers/);
  });

  it('/mcp (no args) returns an action picker list', async () => {
    const c = ctx(createOllamaProvider());
    const out = await COMMANDS.find((c2) => c2.name === '/mcp')!.execute(c, '');
    expect(out && typeof out === 'object' && (out as { kind?: string }).kind).toBe('list');
    if (out && typeof out === 'object' && 'items' in out) {
      const items = (out as { items: { value: string }[] }).items.map((i) => i.value);
      expect(items).toEqual(['list', 'add', 'edit', 'remove', 'reload']);
    }
  });

  it('/mcp add stdio returns a stdio form', async () => {
    const c = ctx(createOllamaProvider());
    const out = await COMMANDS.find((c2) => c2.name === '/mcp')!.execute(c, 'add stdio');
    expect(out && typeof out === 'object' && (out as { kind?: string }).kind).toBe('form');
    if (out && typeof out === 'object' && 'fields' in out) {
      const keys = (out as { fields: { key: string }[] }).fields.map((f) => f.key);
      expect(keys).toEqual(['name', 'command', 'args', 'enabled']);
    }
  });

  it('/mcp add (no transport) returns a transport picker', async () => {
    const c = ctx(createOllamaProvider());
    const out = await COMMANDS.find((c2) => c2.name === '/mcp')!.execute(c, 'add');
    expect(out && typeof out === 'object' && (out as { kind?: string }).kind).toBe('list');
    if (out && typeof out === 'object' && 'items' in out) {
      const items = (out as { items: { value: string }[] }).items.map((i) => i.value);
      expect(items).toEqual(['stdio', 'http']);
    }
  });

  it('/status reports provider, history, and daemon state', async () => {
    const c = ctx(createOllamaProvider());
    const out = (await COMMANDS.find((c2) => c2.name === '/status')!.execute(c, '')) as string;
    expect(out).toMatch(/Provider/);
    expect(out).toMatch(/History/);
    expect(out).toMatch(/Daemon/);
    expect(out).toMatch(/Telegram/);
    expect(out).toMatch(/WhatsApp/);
    expect(out).toMatch(/MCP/);
    // The status line must NOT report the unhelpful "none — run asterisk
    // configure" stub when the user is running on validated defaults.
    expect(out).not.toMatch(/\(none — run/);
  });

  it('/provider (no args) returns a list of providers', async () => {
    const c = ctx(createOllamaProvider());
    const out = await COMMANDS.find((c2) => c2.name === '/provider')!.execute(c, '');
    expect(out && typeof out === 'object' && (out as { kind?: string }).kind).toBe('list');
    if (out && typeof out === 'object' && 'items' in out) {
      const items = (out as { items: { value: string }[] }).items.map((i) => i.value);
      expect(items).toEqual(['ollama', 'anthropic']);
    }
  });

  it('/provider with bad name reports unknown', async () => {
    const c = ctx(createOllamaProvider());
    const out = (await COMMANDS.find((c2) => c2.name === '/provider')!.execute(
      c,
      'gpt-banana',
    )) as string;
    expect(out).toMatch(/unknown provider/);
  });
});
