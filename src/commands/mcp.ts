// `/mcp` — manage Model Context Protocol servers.
//
// Split out of registry.ts, which had grown past 2000 lines against the
// repo's own 800-line limit. Nothing here changed in the move; the visual
// flows (add / edit / remove / reload pickers) are the bulk of it.

import { loadConfig, saveConfig } from '../config/load.ts';
import type { McpServerConfig } from '../config/schema.ts';
import { getDb } from '../db/index.ts';
import { mcpAuthStatus, writeMcpOAuthClient, writeMcpUserToken } from '../db/mcp-credentials.ts';
import { findCatalogConnector } from '../mcp/catalog.ts';
import { callbackRedirectUrl } from '../mcp/oauth/callback.ts';
import { beginConnectorFlow, disconnectConnector } from '../mcp/oauth/connect.ts';
import type { FormSpec, ListSpec } from '../repl/forms/types.ts';
import { setExtraTools } from '../tools/registry.ts';
import type { CommandContext, CommandResult, SlashCommand } from './registry.ts';
import { truncate } from './text.ts';

export const mcpCommand: SlashCommand = {
  name: '/mcp',
  description: 'Manage MCP servers',
  usage: '/mcp [list|resources|read|add|edit|remove|connect|token|client|disconnect|reload]',
  async execute(ctx, args) {
    const trimmed = args.trim();
    if (!trimmed) return mcpActionPicker(ctx);
    const [verb, ...rest] = trimmed.split(/\s+/);

    if (verb === 'list') return formatMcpList(ctx);
    if (verb === 'connect') {
      const name = rest[0];
      return name ? mcpConnect(ctx, name) : mcpConnectorPicker(ctx, 'connect');
    }
    if (verb === 'disconnect') {
      const name = rest[0];
      return name ? mcpDisconnect(ctx, name) : mcpConnectorPicker(ctx, 'disconnect');
    }
    if (verb === 'token') {
      const name = rest[0];
      if (!name) return 'usage: /mcp token <name>';
      return mcpTokenForm(ctx, name);
    }
    if (verb === 'client') {
      const name = rest[0];
      return name ? mcpClientForm(name) : mcpConnectorPicker(ctx, 'client');
    }
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
      {
        value: 'connect',
        label: 'Connect',
        description: 'authorize a connector in the browser (OAuth)',
      },
      {
        value: 'client',
        label: 'OAuth client',
        description: 'supply a client id for a service that registers none (Google)',
      },
      {
        value: 'disconnect',
        label: 'Disconnect',
        description: 'forget a connector’s stored credentials',
      },
      { value: 'reload', label: 'Reload', description: 'reconnect all servers' },
    ],
    onPick: async (v): Promise<CommandResult> => {
      if (v === 'list') return formatMcpList(ctx);
      if (v === 'resources') return formatMcpResources(ctx);
      if (v === 'add') return mcpTransportPicker(ctx);
      if (v === 'edit') return mcpEditPicker(ctx);
      if (v === 'remove') return mcpRemovePicker(ctx);
      if (v === 'connect') return mcpConnectorPicker(ctx, 'connect');
      if (v === 'client') return mcpConnectorPicker(ctx, 'client');
      if (v === 'disconnect') return mcpConnectorPicker(ctx, 'disconnect');
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
        kind: 'select',
        key: 'auth',
        label: 'Authentication',
        defaultValue: 'none',
        options: AUTH_OPTIONS,
      },
      {
        kind: 'confirm',
        key: 'enabled',
        label: 'Enable now?',
        defaultValue: 'yes',
      },
    ],
    onSubmit: async (v) => {
      const name = (v['name'] ?? '').trim();
      const auth = parseAuth(v['auth']);
      const added = await addServer(ctx, {
        name,
        transport: 'http',
        url: (v['url'] ?? '').trim(),
        headers: {},
        auth,
        scopes: [],
        enabled: (v['enabled'] ?? 'yes') === 'yes',
      });
      // A connector is useless until it is authorized, and the add flow is the
      // one moment we know the user is present to do it.
      if (added.startsWith('✓') && auth === 'oauth')
        return `${added}\n\nNext: /mcp connect ${name}`;
      if (added.startsWith('✓') && auth === 'token') return `${added}\n\nNext: /mcp token ${name}`;
      return added;
    },
    onCancel: () => '(cancelled)',
  };
}

const AUTH_OPTIONS = [
  { value: 'none', label: 'none', description: 'public endpoint, or a token in headers' },
  { value: 'oauth', label: 'oauth', description: 'connector — browser consent, auto-refresh' },
  {
    value: 'token',
    label: 'token',
    description: 'connector — a token you issue, stored outside the config',
  },
];

function parseAuth(raw: string | undefined): 'none' | 'oauth' | 'token' {
  return raw === 'oauth' ? 'oauth' : raw === 'token' ? 'token' : 'none';
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
        // addServer() guards these; the edit form did not, so a blank field
        // threw a raw ZodError out of onSubmit and the REPL printed
        // `form error: [{"validation":"url",…}]` at the user.
        const command = (v['command'] ?? '').trim();
        if (!command) return 'command is required';
        const stdioServer = {
          name,
          transport: 'stdio' as const,
          command,
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
        kind: 'select',
        key: 'auth',
        label: 'Authentication',
        defaultValue: existing.auth,
        options: AUTH_OPTIONS,
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
      const url = (v['url'] ?? '').trim();
      if (!url) return 'url is required';
      if (!/^https?:\/\//i.test(url))
        return `url must start with http:// or https:// — got "${url}"`;
      const auth = parseAuth(v['auth']);
      const httpServer = {
        name,
        transport: 'http' as const,
        url,
        headers: existing.headers,
        auth,
        scopes: existing.scopes,
        enabled: (v['enabled'] ?? 'no') === 'yes',
      };
      config.mcpServers[idx] = httpServer;
      // saveConfig → upsertMcpServer drops stored credentials when the URL
      // changes or OAuth is switched off, so a re-consent is expected here and
      // the message below says so rather than letting the next turn fail.
      saveConfig(config);
      const result = await ctx.mcp.reload();
      applyMcpToolsToRegistry(ctx);
      const reconnect =
        auth === 'oauth' && (url !== existing.url || existing.auth !== 'oauth')
          ? `\nCredentials were reset — run: /mcp connect ${name}`
          : '';
      const failed = result.failed.find((f) => f.name === name);
      if (failed) return `updated "${name}" but reconnect failed: ${failed.error}${reconnect}`;
      return `✓ updated "${name}"${reconnect}`;
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
    lines.push(`  ${dot} ${s.name}  [${s.transport}]  ${detail}${authSuffix(s)}`);
  }
  const tools = ctx.mcp.tools;
  if (tools.length > 0)
    lines.push(`(${tools.length} MCP tool${tools.length === 1 ? '' : 's'} available)`);
  return lines.join('\n');
}

/**
 * True when this service's authorization server registers no clients of its own
 * and the user has not supplied one yet — the state in which Connect can do
 * nothing but ask for it.
 */
function needsOAuthClient(server: Extract<McpServerConfig, { transport: 'http' }>): boolean {
  if ((findCatalogConnector(server.name)?.clientRegistration ?? 'dynamic') !== 'manual') {
    return false;
  }
  return !mcpAuthStatus(getDb(), server.name, server.url).hasClient;
}

/** ` · oauth: connected (expires in 42m)` for connectors, nothing for anything else. */
function authSuffix(server: McpServerConfig): string {
  if (server.transport !== 'http' || server.auth === 'none') return '';
  const status = mcpAuthStatus(getDb(), server.name, server.url);
  if (server.auth === 'token') {
    return status.connected ? ' · token: set' : ' · token: missing';
  }
  if (!status.connected) {
    return needsOAuthClient(server) ? ' · oauth: needs a client' : ' · oauth: not connected';
  }
  if (status.expiresAt === undefined) return ' · oauth: connected';
  const remaining = status.expiresAt - Date.now();
  if (remaining <= 0) {
    // Expired is not the same as broken: a refresh token renews it silently on
    // the next call, so say which of the two this is.
    return status.hasRefreshToken
      ? ' · oauth: connected (token expired, refreshes on use)'
      : ' · oauth: expired — reconnect needed';
  }
  return ` · oauth: connected (expires in ${formatDuration(remaining)})`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** Connectors only — a stdio server or an `auth: none` endpoint has nothing to connect. */
function connectors(): Array<Extract<McpServerConfig, { transport: 'http' }>> {
  return loadConfig().config.mcpServers.filter(
    (s: McpServerConfig): s is Extract<McpServerConfig, { transport: 'http' }> =>
      s.transport === 'http' && s.auth !== 'none',
  );
}

const PICKER_TITLES = {
  connect: 'Authorize which connector?',
  disconnect: 'Disconnect which connector?',
  client: 'Set the OAuth client for which connector?',
} as const;

function mcpConnectorPicker(
  ctx: CommandContext,
  action: 'connect' | 'disconnect' | 'client',
): ListSpec {
  const available = connectors();
  return {
    kind: 'list',
    title: PICKER_TITLES[action],
    items: available.map((s) => ({
      value: s.name,
      label: s.name,
      description: `${s.url}${authSuffix(s)}`,
    })),
    emptyMessage: 'No connectors configured. Add an http server with Authentication = oauth first.',
    onPick: (v) => {
      if (action === 'connect') return mcpConnect(ctx, v);
      if (action === 'client') return mcpClientForm(v);
      return mcpDisconnect(ctx, v);
    },
    onCancel: () => null,
  };
}

async function mcpConnect(ctx: CommandContext, name: string): Promise<string> {
  const server = loadConfig().config.mcpServers.find((s: McpServerConfig) => s.name === name);
  if (!server) return `no MCP server named "${name}"`;
  if (server.transport !== 'http') {
    return `"${name}" is a stdio server — OAuth applies to http servers only`;
  }
  if (server.auth === 'token') {
    return `"${name}" authenticates with a token, not a browser flow — use /mcp token ${name}`;
  }
  if (server.auth !== 'oauth') {
    return `"${name}" is not a connector (auth: none). Switch it with /mcp edit ${name}.`;
  }
  // Some authorization servers register no clients at all, so the flow cannot
  // even produce a consent URL until the user's own client id is on file.
  if (needsOAuthClient(server)) {
    return `"${name}" needs an OAuth client you register with the service — run: /mcp client ${name}`;
  }

  try {
    const flow = await beginConnectorFlow({
      name: server.name,
      url: server.url,
      scopes: server.scopes,
    });

    if (flow.status === 'refreshed') {
      const result = await ctx.mcp.reload();
      applyMcpToolsToRegistry(ctx);
      const failed = result.failed.find((f) => f.name === name);
      return failed
        ? `"${name}" was already authorized but connect failed: ${failed.error}`
        : `✓ "${name}" was already authorized`;
    }

    // The exchange finishes in the background: a slash command gets one
    // message, and holding it until the user has finished logging in would
    // freeze the REPL and show the URL only after it was needed.
    void flow.completion
      .then(async () => {
        await ctx.mcp.reload();
        applyMcpToolsToRegistry(ctx);
      })
      .catch(() => {
        // Reported through /mcp list rather than thrown into an idle REPL —
        // an unhandled rejection here would take the process down.
      });

    return [
      flow.browserOpened
        ? `Opened your browser to authorize "${name}".`
        : `Could not open a browser — open this URL to authorize "${name}":`,
      flow.consentUrl ?? '',
      '',
      'Run /mcp list when the browser says it is done.',
    ]
      .filter((line) => line !== '')
      .join('\n');
  } catch (e) {
    return `connect failed: ${(e as Error).message}`;
  }
}

/**
 * Takes a user-issued token for a `token` connector.
 *
 * A form with a secret field rather than an argument on the command line: the
 * REPL keeps its input in scrollback and in the session transcript, and a
 * personal access token typed as `/mcp token github ghp_…` would live in both.
 */
function mcpTokenForm(ctx: CommandContext, name: string): FormSpec | string {
  const server = loadConfig().config.mcpServers.find((s: McpServerConfig) => s.name === name);
  if (!server) return `no MCP server named "${name}"`;
  if (server.transport !== 'http') return `"${name}" is a stdio server`;
  if (server.auth !== 'token') {
    return `"${name}" is not a token connector — its auth is "${server.auth}"`;
  }

  return {
    kind: 'form',
    title: `Token for "${name}"`,
    fields: [{ kind: 'text', key: 'token', label: 'Access token', secret: true, required: true }],
    onSubmit: async (v) => {
      const token = (v['token'] ?? '').trim();
      if (!token) return 'token is required';
      writeMcpUserToken(getDb(), name, server.url, token);
      const result = await ctx.mcp.reload();
      applyMcpToolsToRegistry(ctx);
      const failed = result.failed.find((f) => f.name === name);
      return failed
        ? `stored the token but connect failed: ${failed.error}`
        : `✓ token stored for "${name}"`;
    },
    onCancel: () => '(cancelled)',
  };
}

/**
 * Takes an OAuth client the user registered with the service themselves.
 *
 * Needed wherever the authorization server hands out no registrations of its
 * own — Google's does not — and the redirect URI is printed because the client
 * has to be created with exactly that one allowed.
 */
function mcpClientForm(name: string): FormSpec | string {
  const server = loadConfig().config.mcpServers.find((s: McpServerConfig) => s.name === name);
  if (!server) return `no MCP server named "${name}"`;
  if (server.transport !== 'http') return `"${name}" is a stdio server`;
  if (server.auth !== 'oauth') {
    return `"${name}" is not an OAuth connector — its auth is "${server.auth}"`;
  }
  const url = server.url;
  const entry = findCatalogConnector(name);

  return {
    kind: 'form',
    title: `OAuth client for "${name}"`,
    description: [
      entry?.clientHelp ?? 'An OAuth client you registered with this service.',
      `Allowed redirect URI: ${callbackRedirectUrl()}`,
      ...(server.scopes.length > 0 ? [`Scopes: ${server.scopes.join(' ')}`] : []),
      ...(entry?.clientUrl ? [`Create one at: ${entry.clientUrl}`] : []),
    ].join('\n'),
    fields: [
      { kind: 'text', key: 'clientId', label: 'Client ID', required: true },
      // Optional on purpose: a server that accepts a public client with PKCE
      // issues none, and an empty string is not the same as absent.
      { kind: 'text', key: 'clientSecret', label: 'Client secret (optional)', secret: true },
    ],
    onSubmit: async (v) => {
      const clientId = (v['clientId'] ?? '').trim();
      if (!clientId) return 'client ID is required';
      const clientSecret = (v['clientSecret'] ?? '').trim();
      writeMcpOAuthClient(getDb(), name, url, clientId, clientSecret || undefined);
      return `✓ OAuth client stored for "${name}"\n\nNext: /mcp connect ${name}`;
    },
    onCancel: () => '(cancelled)',
  };
}

async function mcpDisconnect(ctx: CommandContext, name: string): Promise<string> {
  const server = loadConfig().config.mcpServers.find((s: McpServerConfig) => s.name === name);
  if (!server) return `no MCP server named "${name}"`;
  const removed = disconnectConnector(name);
  if (!removed) return `"${name}" had no stored credentials`;
  await ctx.mcp.reload();
  applyMcpToolsToRegistry(ctx);
  return [
    `✓ forgot the stored credentials for "${name}"`,
    'The grant itself is still live upstream — revoke it in the service’s own settings.',
  ].join('\n');
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
