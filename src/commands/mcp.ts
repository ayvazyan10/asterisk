// `/mcp` — manage Model Context Protocol servers.
//
// Split out of registry.ts, which had grown past 2000 lines against the
// repo's own 800-line limit. Nothing here changed in the move; the visual
// flows (add / edit / remove / reload pickers) are the bulk of it.

import { loadConfig, saveConfig } from '../config/load.ts';
import type { McpServerConfig } from '../config/schema.ts';
import type { FormSpec, ListSpec } from '../repl/forms/types.ts';
import { setExtraTools } from '../tools/registry.ts';
import type { CommandContext, CommandResult, SlashCommand } from './registry.ts';
import { truncate } from './text.ts';

export const mcpCommand: SlashCommand = {
  name: '/mcp',
  description: 'Manage MCP servers',
  usage: '/mcp [list|resources|read|add|edit|remove|reload]',
  async execute(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) return mcpActionPicker(ctx);
    const [verb, ...rest] = trimmed.split(/\s+/);

    if (verb === 'list') return formatMcpList(ctx);
    if (verb === 'resources') return formatMcpResources(ctx, rest[0]);
    if (verb === 'read') return readMcpResource(ctx, rest[0], rest.slice(1).join(' '));
    if (verb === 'reload') return mcpReload(ctx);
    if (verb === 'remove') {
      const name = rest[0];
      if (!name) return mcpRemovePicker(ctx);
      return mcpConfirmRemove(ctx, name);
    }
    if (verb === 'edit') {
      const name = rest[0];
      if (!name) return mcpEditPicker(ctx);
      return mcpEditForm(ctx, name);
    }
    if (verb === 'add') {
      const transport = rest[0];
      if (!transport) return mcpTransportPicker(ctx);
      if (transport === 'stdio' || transport === 'http') {
        return mcpAddForm(ctx, transport);
      }
      return `unknown transport: ${transport}`;
    }
    return `unknown /mcp verb: ${verb}`;
  },
};

// ─────────────────────────────────────────────────────────────────────────
//  MCP visual flows
// ─────────────────────────────────────────────────────────────────────────

function mcpActionPicker(ctx: CommandContext): ListSpec {
  return {
    kind: 'list',
    title: 'MCP servers — pick an action',
    items: [
      { value: 'list', label: 'List', description: 'show configured + connected servers' },
      { value: 'resources', label: 'Resources', description: 'list connected MCP resources' },
      { value: 'add', label: 'Add', description: 'register a new MCP server' },
      { value: 'edit', label: 'Edit', description: 'change an existing server' },
      { value: 'remove', label: 'Remove', description: 'delete a server' },
      { value: 'reload', label: 'Reload', description: 'reconnect all servers' },
    ],
    onPick: async (v): Promise<CommandResult> => {
      if (v === 'list') return formatMcpList(ctx);
      if (v === 'resources') return formatMcpResources(ctx);
      if (v === 'add') return mcpTransportPicker(ctx);
      if (v === 'edit') return mcpEditPicker(ctx);
      if (v === 'remove') return mcpRemovePicker(ctx);
      if (v === 'reload') return mcpReload(ctx);
      return null;
    },
    onCancel: () => null,
  };
}

function mcpTransportPicker(ctx: CommandContext): ListSpec {
  return {
    kind: 'list',
    title: 'Add MCP server — pick a transport',
    items: [
      {
        value: 'stdio',
        label: 'stdio',
        description: 'spawn a local subprocess and talk over stdin/stdout',
      },
      {
        value: 'http',
        label: 'http',
        description: 'connect to a Streamable HTTP endpoint',
      },
    ],
    onPick: (v) => mcpAddForm(ctx, v as 'stdio' | 'http'),
    onCancel: () => null,
  };
}

function mcpAddForm(ctx: CommandContext, transport: 'stdio' | 'http'): FormSpec {
  if (transport === 'stdio') {
    return {
      kind: 'form',
      title: 'Add MCP server (stdio)',
      fields: [
        { kind: 'text', key: 'name', label: 'Name', placeholder: 'my-server', required: true },
        {
          kind: 'text',
          key: 'command',
          label: 'Command',
          placeholder: 'node /path/to/server.js',
          required: true,
        },
        {
          kind: 'text',
          key: 'args',
          label: 'Extra args (space-separated)',
          placeholder: 'optional',
          multiToken: true,
        },
        {
          kind: 'confirm',
          key: 'enabled',
          label: 'Enable now?',
          defaultValue: 'yes',
        },
      ],
      onSubmit: async (v) =>
        addServer(ctx, {
          name: (v['name'] ?? '').trim(),
          transport: 'stdio',
          command: (v['command'] ?? '').trim(),
          args: parseArgs(v['args'] ?? ''),
          env: {},
          enabled: (v['enabled'] ?? 'yes') === 'yes',
        }),
      onCancel: () => '(cancelled)',
    };
  }
  return {
    kind: 'form',
    title: 'Add MCP server (http)',
    fields: [
      { kind: 'text', key: 'name', label: 'Name', placeholder: 'my-server', required: true },
      {
        kind: 'text',
        key: 'url',
        label: 'URL',
        placeholder: 'https://example.com/mcp',
        required: true,
      },
      {
        kind: 'confirm',
        key: 'enabled',
        label: 'Enable now?',
        defaultValue: 'yes',
      },
    ],
    onSubmit: async (v) =>
      addServer(ctx, {
        name: (v['name'] ?? '').trim(),
        transport: 'http',
        url: (v['url'] ?? '').trim(),
        headers: {},
        enabled: (v['enabled'] ?? 'yes') === 'yes',
      }),
    onCancel: () => '(cancelled)',
  };
}

function mcpRemovePicker(ctx: CommandContext): ListSpec {
  const cfg = loadConfig().config;
  return {
    kind: 'list',
    title: 'Remove which MCP server?',
    items: cfg.mcpServers.map((s: McpServerConfig) => ({
      value: s.name,
      label: s.name,
      description: s.transport === 'stdio' ? `stdio · ${s.command}` : `http · ${s.url}`,
    })),
    emptyMessage: 'No MCP servers configured.',
    onPick: (v) => mcpConfirmRemove(ctx, v),
    onCancel: () => null,
  };
}

function mcpConfirmRemove(ctx: CommandContext, name: string): FormSpec {
  return {
    kind: 'form',
    title: `Remove MCP server "${name}"?`,
    fields: [{ kind: 'confirm', key: 'confirm', label: 'Are you sure?', defaultValue: 'no' }],
    onSubmit: async (v) => {
      if (v['confirm'] !== 'yes') return '(kept)';
      const cfg = loadConfig();
      const before = cfg.config.mcpServers.length;
      cfg.config.mcpServers = cfg.config.mcpServers.filter((s: McpServerConfig) => s.name !== name);
      if (cfg.config.mcpServers.length === before) return `no MCP server named "${name}"`;
      saveConfig(cfg.config);
      const result = await ctx.mcp.reload();
      applyMcpToolsToRegistry(ctx);
      return `✓ removed "${name}" (now ${result.connected.length} connected)`;
    },
    onCancel: () => '(cancelled)',
  };
}

function mcpEditPicker(ctx: CommandContext): ListSpec {
  const cfg = loadConfig().config;
  return {
    kind: 'list',
    title: 'Edit which MCP server?',
    items: cfg.mcpServers.map((s: McpServerConfig) => ({
      value: s.name,
      label: s.name,
      description: s.transport === 'stdio' ? `stdio · ${s.command}` : `http · ${s.url}`,
    })),
    emptyMessage: 'No MCP servers to edit.',
    onPick: (v) => mcpEditForm(ctx, v),
    onCancel: () => null,
  };
}

function mcpEditForm(ctx: CommandContext, name: string): FormSpec | string {
  const cfg = loadConfig();
  const existing = cfg.config.mcpServers.find((s: McpServerConfig) => s.name === name);
  if (!existing) return `no MCP server named "${name}"`;

  if (existing.transport === 'stdio') {
    return {
      kind: 'form',
      title: `Edit MCP server "${name}" (stdio)`,
      fields: [
        {
          kind: 'text',
          key: 'command',
          label: 'Command',
          defaultValue: existing.command,
          required: true,
        },
        {
          kind: 'text',
          key: 'args',
          label: 'Extra args (space-separated)',
          defaultValue: existing.args.join(' '),
          multiToken: true,
        },
        {
          kind: 'confirm',
          key: 'enabled',
          label: 'Enabled?',
          defaultValue: existing.enabled ? 'yes' : 'no',
        },
      ],
      onSubmit: async (v) => {
        const config = loadConfig().config;
        const idx = config.mcpServers.findIndex((s: McpServerConfig) => s.name === name);
        if (idx === -1) return `"${name}" was removed elsewhere; nothing to update`;
        const stdioServer = {
          name,
          transport: 'stdio' as const,
          command: (v['command'] ?? '').trim(),
          args: parseArgs(v['args'] ?? ''),
          env: existing.env,
          enabled: (v['enabled'] ?? 'no') === 'yes',
        };
        config.mcpServers[idx] = stdioServer;
        saveConfig(config);
        const result = await ctx.mcp.reload();
        applyMcpToolsToRegistry(ctx);
        const failed = result.failed.find((f) => f.name === name);
        if (failed) return `updated "${name}" but reconnect failed: ${failed.error}`;
        return `✓ updated "${name}"`;
      },
      onCancel: () => '(cancelled)',
    };
  }

  return {
    kind: 'form',
    title: `Edit MCP server "${name}" (http)`,
    fields: [
      { kind: 'text', key: 'url', label: 'URL', defaultValue: existing.url, required: true },
      {
        kind: 'confirm',
        key: 'enabled',
        label: 'Enabled?',
        defaultValue: existing.enabled ? 'yes' : 'no',
      },
    ],
    onSubmit: async (v) => {
      const config = loadConfig().config;
      const idx = config.mcpServers.findIndex((s: McpServerConfig) => s.name === name);
      if (idx === -1) return `"${name}" was removed elsewhere; nothing to update`;
      const httpServer = {
        name,
        transport: 'http' as const,
        url: (v['url'] ?? '').trim(),
        headers: existing.headers,
        enabled: (v['enabled'] ?? 'no') === 'yes',
      };
      config.mcpServers[idx] = httpServer;
      saveConfig(config);
      const result = await ctx.mcp.reload();
      applyMcpToolsToRegistry(ctx);
      const failed = result.failed.find((f) => f.name === name);
      if (failed) return `updated "${name}" but reconnect failed: ${failed.error}`;
      return `✓ updated "${name}"`;
    },
    onCancel: () => '(cancelled)',
  };
}

async function mcpReload(ctx: CommandContext): Promise<string> {
  const result = await ctx.mcp.reload();
  applyMcpToolsToRegistry(ctx);
  const lines = [`reloaded ${ctx.mcp.servers.length} MCP server(s)`];
  for (const c of result.connected) lines.push(`  ✓ ${c}`);
  for (const f of result.failed) lines.push(`  ✗ ${f.name}: ${f.error}`);
  return lines.join('\n');
}

function formatMcpList(ctx: CommandContext): string {
  const cfg = loadConfig().config;
  const configured = cfg.mcpServers;
  const connected = new Set(ctx.mcp.servers.map((s) => s.config.name));
  if (configured.length === 0) {
    return ['No MCP servers configured.', 'Use /mcp add to register one.'].join('\n');
  }
  const lines = ['MCP servers:'];
  for (const s of configured) {
    const live = connected.has(s.name);
    const dot = live ? '●' : s.enabled ? '○' : '·';
    const detail =
      s.transport === 'stdio'
        ? `${s.command}${s.args.length ? ` ${s.args.join(' ')}` : ''}`
        : s.url;
    lines.push(`  ${dot} ${s.name}  [${s.transport}]  ${detail}`);
  }
  const tools = ctx.mcp.tools;
  if (tools.length > 0)
    lines.push(`(${tools.length} MCP tool${tools.length === 1 ? '' : 's'} available)`);
  return lines.join('\n');
}

async function formatMcpResources(ctx: CommandContext, serverName?: string): Promise<string> {
  const servers = ctx.mcp.servers.filter((s) => !serverName || s.config.name === serverName);
  if (servers.length === 0) {
    return serverName ? `MCP server not connected: ${serverName}` : '(no MCP servers connected)';
  }
  const lines: string[] = ['MCP resources:'];
  for (const server of servers) {
    try {
      const listed = await server.client.listResources();
      lines.push(`  ${server.config.name} · ${listed.resources.length} resource(s)`);
      for (const r of listed.resources) {
        const label = r.name ? ` · ${r.name}` : '';
        const mime = r.mimeType ? ` · ${r.mimeType}` : '';
        lines.push(`    ${r.uri}${label}${mime}`);
      }
    } catch (e) {
      lines.push(`  ${server.config.name} · unavailable: ${(e as Error).message}`);
    }
  }
  lines.push('');
  lines.push('Use /mcp read <server> <uri> to inspect one.');
  return lines.join('\n');
}

async function readMcpResource(
  ctx: CommandContext,
  serverName: string | undefined,
  uri: string,
): Promise<string> {
  if (!serverName || !uri.trim()) return 'usage: /mcp read <server> <uri>';
  const server = ctx.mcp.servers.find((s) => s.config.name === serverName);
  if (!server) return `MCP server not connected: ${serverName}`;
  try {
    const result = await server.client.readResource({ uri: uri.trim() });
    const output = result.contents
      .map((item) => {
        if ('text' in item && typeof item.text === 'string') return item.text;
        return JSON.stringify(item);
      })
      .join('\n');
    return truncate(output, 50000);
  } catch (e) {
    return `MCP resource read failed: ${(e as Error).message}`;
  }
}

function applyMcpToolsToRegistry(ctx: CommandContext): void {
  setExtraTools(ctx.mcp.tools);
}

async function addServer(ctx: CommandContext, server: McpServerConfig): Promise<string> {
  if (!server.name) return 'name is required';
  if (server.transport === 'stdio' && !server.command) return 'command is required';
  if (server.transport === 'http' && !server.url) return 'url is required';
  const cfg = loadConfig();
  if (cfg.config.mcpServers.some((s: McpServerConfig) => s.name === server.name)) {
    return `MCP server "${server.name}" already exists`;
  }
  cfg.config.mcpServers.push(server);
  saveConfig(cfg.config);
  const result = await ctx.mcp.reload();
  applyMcpToolsToRegistry(ctx);
  const ok = result.connected.find((s) => s.startsWith(`${server.name} `));
  if (ok) return `✓ added "${server.name}" — ${ok}`;
  const failed = result.failed.find((f) => f.name === server.name);
  if (failed) return `added "${server.name}" but connect failed: ${failed.error}`;
  return `✓ added "${server.name}"`;
}

function parseArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}
