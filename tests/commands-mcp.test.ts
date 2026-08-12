// `/mcp` end to end.
//
// The command itself only routes; the work happens in the `onSubmit` /
// `onPick` callbacks of the FormSpec and ListSpec it returns. So every test
// here takes the returned spec, invokes the callback the REPL would invoke,
// and then asserts against the stored config — not against the sentence the
// callback returned.

import { describe, expect, it } from 'vitest';

import { loadConfig, saveConfig } from '../src/config/load.ts';
import type { McpServerConfig } from '../src/config/schema.ts';
import { listTools } from '../src/tools/registry.ts';
import {
  asForm,
  asList,
  asText,
  fakeMcp,
  fakeServer,
  keys,
  makeContext,
  pickText,
  run,
  runForm,
  runList,
  runText,
  submitText,
  values,
  withTempHome,
} from './commands-harness.ts';

const servers = (): McpServerConfig[] => loadConfig().config.mcpServers;

/** Seeds the config with servers so the pickers have something to show. */
function seed(...entries: McpServerConfig[]): void {
  const cfg = loadConfig().config;
  cfg.mcpServers = entries;
  saveConfig(cfg);
}

const stdio = (name: string, command = 'node server.js', enabled = true): McpServerConfig => ({
  name,
  transport: 'stdio',
  command,
  args: ['--flag'],
  env: {},
  enabled,
});

const http = (name: string, url = 'https://example.com/mcp', enabled = true): McpServerConfig => ({
  name,
  transport: 'http',
  url,
  headers: {},
  enabled,
});

describe('/mcp routing', () => {
  withTempHome('mcp');

  it('rejects an unknown verb rather than falling through to the list', async () => {
    expect(await runText(makeContext(), '/mcp', 'lst')).toBe('unknown /mcp verb: lst');
  });

  it('rejects an unknown transport', async () => {
    expect(await runText(makeContext(), '/mcp', 'add carrier-pigeon')).toBe(
      'unknown transport: carrier-pigeon',
    );
  });

  it('routes every entry of the action picker to the right flow', async () => {
    const ctx = makeContext({ mcp: fakeMcp([fakeServer('live')]) });
    seed(stdio('live'));
    const picker = await runList(ctx, '/mcp');
    expect(values(picker)).toEqual(['list', 'resources', 'add', 'edit', 'remove', 'reload']);

    expect(asText(await picker.onPick('list'))).toContain('MCP servers:');
    expect(asText(await picker.onPick('resources'))).toContain('MCP resources:');
    expect(asList(await picker.onPick('add')).title).toMatch(/pick a transport/);
    expect(asList(await picker.onPick('edit')).title).toMatch(/Edit which/);
    expect(asList(await picker.onPick('remove')).title).toMatch(/Remove which/);
    expect(asText(await picker.onPick('reload'))).toMatch(/reloaded/);
    expect(await picker.onPick('nonsense')).toBeNull();
    expect(picker.onCancel?.()).toBeNull();
  });

  it('the transport picker opens the matching add form', async () => {
    const ctx = makeContext();
    const picker = await runList(ctx, '/mcp', 'add');
    expect(keys(asForm(await picker.onPick('stdio')))).toEqual([
      'name',
      'command',
      'args',
      'enabled',
    ]);
    expect(keys(asForm(await picker.onPick('http')))).toEqual(['name', 'url', 'enabled']);
    expect(picker.onCancel?.()).toBeNull();
  });
});

describe('/mcp add', () => {
  withTempHome('mcp-add');

  it('stores a stdio server, splits its args, and reconnects', async () => {
    const ctx = makeContext();
    ctx.mcp.nextReload = { connected: ['docs (3 tools)'], failed: [] };
    const form = await runForm(ctx, '/mcp', 'add stdio');

    const out = await submitText(form, {
      name: 'docs',
      command: '  node /srv/docs.js  ',
      args: '  --port 9000   --verbose ',
      enabled: 'yes',
    });

    expect(servers()).toEqual([
      {
        name: 'docs',
        transport: 'stdio',
        command: 'node /srv/docs.js',
        args: ['--port', '9000', '--verbose'],
        env: {},
        enabled: true,
      },
    ]);
    expect(ctx.mcp.reloads).toBe(1);
    expect(out).toContain('docs (3 tools)');
  });

  it('stores an http server and honours "Enable now? no"', async () => {
    const ctx = makeContext();
    const form = await runForm(ctx, '/mcp', 'add http');
    await submitText(form, { name: 'remote', url: ' https://mcp.example/api ', enabled: 'no' });

    expect(servers()).toEqual([
      {
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example/api',
        headers: {},
        enabled: false,
      },
    ]);
  });

  it('defaults enabled to yes and args to empty when the form comes back bare', async () => {
    const ctx = makeContext();
    const form = await runForm(ctx, '/mcp', 'add stdio');
    await submitText(form, { name: 'bare', command: 'noop' });
    expect(servers()[0]).toMatchObject({ args: [], enabled: true });
  });

  it('refuses a blank name, a blank command, and a blank url without writing', async () => {
    const ctx = makeContext();
    const stdioForm = await runForm(ctx, '/mcp', 'add stdio');
    expect(await submitText(stdioForm, { name: '   ', command: 'noop' })).toBe('name is required');
    expect(await submitText(stdioForm, { name: 'x', command: '  ' })).toBe('command is required');
    // A field the form never returned at all is the same as a blank one.
    expect(await submitText(stdioForm, { name: 'x' })).toBe('command is required');

    const httpForm = await runForm(ctx, '/mcp', 'add http');
    expect(await submitText(httpForm, { name: 'x', url: '' })).toBe('url is required');
    expect(await submitText(httpForm, { name: 'x' })).toBe('url is required');

    expect(servers()).toEqual([]);
    expect(ctx.mcp.reloads).toBe(0);
  });

  it('refuses a duplicate name and leaves the existing entry untouched', async () => {
    seed(stdio('docs', 'original.js'));
    const ctx = makeContext();
    const form = await runForm(ctx, '/mcp', 'add stdio');

    expect(await submitText(form, { name: 'docs', command: 'replacement.js' })).toBe(
      'MCP server "docs" already exists',
    );
    expect(servers()).toHaveLength(1);
    expect(servers()[0]).toMatchObject({ command: 'original.js' });
    expect(ctx.mcp.reloads).toBe(0);
  });

  it('reports a connect failure but keeps the server configured', async () => {
    const ctx = makeContext();
    ctx.mcp.nextReload = { connected: [], failed: [{ name: 'docs', error: 'ENOENT' }] };
    const form = await runForm(ctx, '/mcp', 'add stdio');

    const out = await submitText(form, { name: 'docs', command: 'missing.js' });
    expect(out).toContain('connect failed: ENOENT');
    expect(servers()).toHaveLength(1);
  });

  it('reports a plain success when the reload says nothing about the server', async () => {
    const ctx = makeContext();
    const form = await runForm(ctx, '/mcp', 'add stdio');
    // Disabled servers are skipped by the manager, so neither list mentions them.
    expect(await submitText(form, { name: 'docs', command: 'noop', enabled: 'no' })).toBe(
      '✓ added "docs"',
    );
  });

  it('cancelling either transport form writes nothing', async () => {
    for (const transport of ['stdio', 'http']) {
      const form = await runForm(makeContext(), '/mcp', `add ${transport}`);
      expect(await form.onCancel?.(), transport).toBe('(cancelled)');
    }
    expect(servers()).toEqual([]);
  });
});

describe('/mcp remove', () => {
  withTempHome('mcp-remove');

  it('deletes the server only after the confirm field says yes', async () => {
    seed(stdio('docs'), http('remote'));
    const ctx = makeContext();

    const kept = await runForm(ctx, '/mcp', 'remove docs');
    expect(await submitText(kept, { confirm: 'no' })).toBe('(kept)');
    expect(servers()).toHaveLength(2);
    expect(ctx.mcp.reloads).toBe(0);

    ctx.mcp.nextReload = { connected: ['remote (1 tools)'], failed: [] };
    const removed = await runForm(ctx, '/mcp', 'remove docs');
    expect(await submitText(removed, { confirm: 'yes' })).toBe(
      '✓ removed "docs" (now 1 connected)',
    );
    expect(servers().map((s) => s.name)).toEqual(['remote']);
    expect(ctx.mcp.reloads).toBe(1);
  });

  it('reports a name that is not there instead of silently succeeding', async () => {
    seed(stdio('docs'));
    const form = await runForm(makeContext(), '/mcp', 'remove ghost');
    expect(await submitText(form, { confirm: 'yes' })).toBe('no MCP server named "ghost"');
    expect(servers()).toHaveLength(1);
  });

  it('the picker lists every server with its transport detail', async () => {
    seed(stdio('docs', 'node docs.js'), http('remote', 'https://mcp.example/api'));
    const picker = await runList(makeContext(), '/mcp', 'remove');
    expect(values(picker)).toEqual(['docs', 'remote']);
    expect(picker.items[0]?.description).toBe('stdio · node docs.js');
    expect(picker.items[1]?.description).toBe('http · https://mcp.example/api');
    expect(asForm(await picker.onPick('docs')).title).toBe('Remove MCP server "docs"?');
    expect(picker.onCancel?.()).toBeNull();
  });

  it('the picker carries an empty message rather than an empty box', async () => {
    const picker = await runList(makeContext(), '/mcp', 'remove');
    expect(picker.items).toEqual([]);
    expect(picker.emptyMessage).toBe('No MCP servers configured.');
  });

  it('cancelling keeps the server', async () => {
    seed(stdio('docs'));
    const form = await runForm(makeContext(), '/mcp', 'remove docs');
    expect(await form.onCancel?.()).toBe('(cancelled)');
    expect(servers()).toHaveLength(1);
  });
});

describe('/mcp edit', () => {
  withTempHome('mcp-edit');

  it('prefills the stdio form from the stored server and writes the edit back', async () => {
    seed(stdio('docs', 'node docs.js', false));
    const ctx = makeContext();
    const form = await runForm(ctx, '/mcp', 'edit docs');

    expect(form.fields).toContainEqual(
      expect.objectContaining({ key: 'command', defaultValue: 'node docs.js' }),
    );
    expect(form.fields).toContainEqual(
      expect.objectContaining({ key: 'args', defaultValue: '--flag' }),
    );
    expect(form.fields).toContainEqual(
      expect.objectContaining({ key: 'enabled', defaultValue: 'no' }),
    );

    expect(await submitText(form, { command: 'bun docs.ts', args: '-a -b', enabled: 'yes' })).toBe(
      '✓ updated "docs"',
    );
    expect(servers()).toEqual([
      {
        name: 'docs',
        transport: 'stdio',
        command: 'bun docs.ts',
        args: ['-a', '-b'],
        env: {},
        enabled: true,
      },
    ]);
    expect(ctx.mcp.reloads).toBe(1);
  });

  it('prefills and writes back the http form', async () => {
    seed(http('remote', 'https://old.example/mcp'));
    const ctx = makeContext();
    const form = await runForm(ctx, '/mcp', 'edit remote');
    expect(form.fields).toContainEqual(
      expect.objectContaining({ key: 'url', defaultValue: 'https://old.example/mcp' }),
    );

    await submitText(form, { url: ' https://new.example/mcp ', enabled: 'no' });
    expect(servers()).toEqual([
      {
        name: 'remote',
        transport: 'http',
        url: 'https://new.example/mcp',
        headers: {},
        enabled: false,
      },
    ]);
  });

  it('reports a reconnect failure on either transport while still keeping the edit', async () => {
    seed(stdio('docs'), http('remote'));
    const ctx = makeContext();
    ctx.mcp.nextReload = {
      connected: [],
      failed: [
        { name: 'docs', error: 'spawn failed' },
        { name: 'remote', error: 'HTTP 502' },
      ],
    };

    const stdioForm = await runForm(ctx, '/mcp', 'edit docs');
    expect(await submitText(stdioForm, { command: 'broken.js', enabled: 'yes' })).toBe(
      'updated "docs" but reconnect failed: spawn failed',
    );
    expect(servers()[0]).toMatchObject({ command: 'broken.js' });

    const httpForm = await runForm(ctx, '/mcp', 'edit remote');
    expect(await submitText(httpForm, { url: 'https://broken.example/', enabled: 'yes' })).toBe(
      'updated "remote" but reconnect failed: HTTP 502',
    );
    expect(servers()[1]).toMatchObject({ url: 'https://broken.example/' });
  });

  it('treats a field the form did not return as its stored-off default', async () => {
    seed(stdio('docs', 'node docs.js'), http('remote', 'https://old.example/mcp', false));
    const ctx = makeContext();

    // No "enabled" key at all disables, because the confirm defaults to no.
    await submitText(await runForm(ctx, '/mcp', 'edit docs'), { command: 'x' });
    expect(servers()[0]).toMatchObject({ enabled: false });

    // The http form prefills "Enabled?" from the stored value, disabled here.
    const httpForm = await runForm(ctx, '/mcp', 'edit remote');
    expect(httpForm.fields).toContainEqual(
      expect.objectContaining({ key: 'enabled', defaultValue: 'no' }),
    );
    await submitText(httpForm, { url: 'https://old.example/mcp' });
    expect(servers()[1]).toMatchObject({ url: 'https://old.example/mcp', enabled: false });
  });

  it('does not resurrect a server removed while the form was open', async () => {
    seed(stdio('docs'), http('remote'));
    const ctx = makeContext();
    const stdioForm = await runForm(ctx, '/mcp', 'edit docs');
    const httpForm = await runForm(ctx, '/mcp', 'edit remote');

    seed(); // both deleted from another window

    expect(await submitText(stdioForm, { command: 'x', enabled: 'yes' })).toBe(
      '"docs" was removed elsewhere; nothing to update',
    );
    expect(await submitText(httpForm, { url: 'https://x/', enabled: 'yes' })).toBe(
      '"remote" was removed elsewhere; nothing to update',
    );
    expect(servers()).toEqual([]);
  });

  it('reports an unknown name as text, not an empty form', async () => {
    expect(await runText(makeContext(), '/mcp', 'edit ghost')).toBe('no MCP server named "ghost"');
  });

  it('the picker offers every server and its empty message', async () => {
    const empty = await runList(makeContext(), '/mcp', 'edit');
    expect(empty.emptyMessage).toBe('No MCP servers to edit.');

    seed(stdio('docs', 'node docs.js'), http('remote', 'https://mcp.example/api'));
    const picker = await runList(makeContext(), '/mcp', 'edit');
    expect(values(picker)).toEqual(['docs', 'remote']);
    expect(picker.items[0]?.description).toBe('stdio · node docs.js');
    expect(picker.items[1]?.description).toBe('http · https://mcp.example/api');
    expect(asForm(await picker.onPick('docs')).title).toBe('Edit MCP server "docs" (stdio)');
    expect(picker.onCancel?.()).toBeNull();
  });

  it('cancelling either edit form leaves the server as it was', async () => {
    seed(stdio('docs', 'node docs.js'), http('remote', 'https://old.example/mcp'));
    for (const name of ['docs', 'remote']) {
      const form = await runForm(makeContext(), '/mcp', `edit ${name}`);
      expect(await form.onCancel?.(), name).toBe('(cancelled)');
    }
    expect(servers()[0]).toMatchObject({ command: 'node docs.js' });
    expect(servers()[1]).toMatchObject({ url: 'https://old.example/mcp' });
  });
});

describe('/mcp list, reload and resources', () => {
  withTempHome('mcp-read');

  it('marks connected, enabled-but-down and disabled servers differently', async () => {
    const bare: McpServerConfig = {
      name: 'bare',
      transport: 'stdio',
      command: 'node bare.js',
      args: [],
      env: {},
      enabled: true,
    };
    seed(
      stdio('live', 'node live.js'),
      stdio('down'),
      stdio('off', 'node off.js', false),
      bare,
      http('remote', 'https://mcp.example/api'),
    );
    const ctx = makeContext({ mcp: fakeMcp([fakeServer('live')]) });

    const out = await runText(ctx, '/mcp', 'list');
    const line = (name: string): string =>
      out.split('\n').find((l) => l.includes(` ${name}  [`)) ?? '';
    expect(line('live').trim().startsWith('●')).toBe(true);
    expect(line('down').trim().startsWith('○')).toBe(true);
    expect(line('off').trim().startsWith('·')).toBe(true);
    expect(line('live')).toContain('node live.js');
    // stdio args are shown alongside the command, and omitted when there are none.
    expect(line('down')).toContain('--flag');
    expect(line('bare').trimEnd().endsWith('node bare.js')).toBe(true);
    // An http server shows its URL where a stdio one shows its command line.
    expect(line('remote')).toContain('https://mcp.example/api');
  });

  it('counts MCP tools only when there are some', async () => {
    seed(stdio('live'));
    const bare = await runText(makeContext(), '/mcp', 'list');
    expect(bare).not.toMatch(/MCP tools? available/);

    const tool = {
      name: 'mcp__live__ping',
      description: 'ping',
      input_schema: { type: 'object' as const, properties: {} },
      async execute() {
        return { output: 'pong', isError: false };
      },
    };
    const one = await runText(makeContext({ mcp: fakeMcp([], [tool]) }), '/mcp', 'list');
    expect(one).toContain('(1 MCP tool available)');
    const two = await runText(makeContext({ mcp: fakeMcp([], [tool, tool]) }), '/mcp', 'list');
    expect(two).toContain('(2 MCP tools available)');
  });

  it('reload republishes the MCP tools into the global registry', async () => {
    const tool = {
      name: 'mcp__live__ping',
      description: 'ping',
      input_schema: { type: 'object' as const, properties: {} },
      async execute() {
        return { output: 'pong', isError: false };
      },
    };
    const ctx = makeContext({ mcp: fakeMcp([fakeServer('live')], [tool]) });
    ctx.mcp.nextReload = { connected: ['live (1 tools)'], failed: [{ name: 'x', error: 'boom' }] };

    const out = await runText(ctx, '/mcp', 'reload');
    expect(out).toContain('reloaded 1 MCP server(s)');
    expect(out).toContain('✓ live (1 tools)');
    expect(out).toContain('✗ x: boom');
    expect(listTools().map((t) => t.name)).toContain('mcp__live__ping');

    // Leave the shared registry as it was found.
    const cleanup = makeContext({ mcp: fakeMcp() });
    await run(cleanup, '/mcp', 'reload');
    expect(listTools().map((t) => t.name)).not.toContain('mcp__live__ping');
  });

  it('resources lists what each connected server offers', async () => {
    const ctx = makeContext({
      mcp: fakeMcp([
        fakeServer('docs', {
          async listResources() {
            return {
              resources: [
                { uri: 'file:///a.md', name: 'A', mimeType: 'text/markdown' },
                { uri: 'file:///b.md' },
              ],
            };
          },
        }),
      ]),
    });

    const out = await runText(ctx, '/mcp', 'resources');
    expect(out).toContain('docs · 2 resource(s)');
    expect(out).toContain('file:///a.md · A · text/markdown');
    expect(out).toContain('file:///b.md');
    expect(out).toContain('/mcp read');
  });

  it('resources survives a server that cannot answer', async () => {
    const ctx = makeContext({
      mcp: fakeMcp([
        fakeServer('broken', {
          async listResources() {
            throw new Error('protocol error');
          },
        }),
      ]),
    });
    expect(await runText(ctx, '/mcp', 'resources')).toContain(
      'broken · unavailable: protocol error',
    );
  });

  it('resources reports the right emptiness for "none connected" vs "not that one"', async () => {
    expect(await runText(makeContext(), '/mcp', 'resources')).toBe('(no MCP servers connected)');
    const ctx = makeContext({ mcp: fakeMcp([fakeServer('docs')]) });
    expect(await runText(ctx, '/mcp', 'resources ghost')).toBe('MCP server not connected: ghost');
  });

  it('read requires both arguments and a connected server', async () => {
    const ctx = makeContext({ mcp: fakeMcp([fakeServer('docs')]) });
    expect(await runText(ctx, '/mcp', 'read')).toBe('usage: /mcp read <server> <uri>');
    expect(await runText(ctx, '/mcp', 'read docs')).toBe('usage: /mcp read <server> <uri>');
    expect(await runText(ctx, '/mcp', 'read docs    ')).toBe('usage: /mcp read <server> <uri>');
    expect(await runText(ctx, '/mcp', 'read ghost file:///a.md')).toBe(
      'MCP server not connected: ghost',
    );
  });

  it('read joins text contents, JSON-encodes the rest, and clips at 50k', async () => {
    let asked = '';
    const ctx = makeContext({
      mcp: fakeMcp([
        fakeServer('docs', {
          async readResource({ uri }: { uri: string }) {
            asked = uri;
            return {
              contents: [
                { uri, text: 'hello' },
                { uri, blob: 'AAAA' },
                { uri, text: 'x'.repeat(60_000) },
              ],
            };
          },
        }),
      ]),
    });

    const out = await runText(ctx, '/mcp', 'read docs  file:///a.md  ');
    expect(asked).toBe('file:///a.md');
    expect(out.startsWith('hello\n')).toBe(true);
    expect(out).toContain('"blob":"AAAA"');
    expect(out.endsWith('\n[truncated]')).toBe(true);
    expect(out.length).toBe(50_000 + '\n[truncated]'.length);
  });

  it('read reports a failure instead of throwing out of the command', async () => {
    const ctx = makeContext({
      mcp: fakeMcp([
        fakeServer('docs', {
          async readResource() {
            throw new Error('no such resource');
          },
        }),
      ]),
    });
    expect(await runText(ctx, '/mcp', 'read docs file:///missing')).toBe(
      'MCP resource read failed: no such resource',
    );
  });
});
