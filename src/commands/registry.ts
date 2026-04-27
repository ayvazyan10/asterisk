// Slash-command registry. Commands receive a context with mutators (set
// provider, clear history, exit), do their work, and return a CommandResult:
// a string to render, null for no output, or a FormSpec / ListSpec to render
// an interactive modal in the REPL.

import { existsSync } from 'node:fs';

import type { AgentState } from '../agent/loop.ts';
import { loadConfig, saveConfig, saveSecrets } from '../config/load.ts';
import type { McpServerConfig } from '../config/schema.ts';
import type { McpManager } from '../mcp/manager.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { listTools, setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { statusFromPidFile } from '../daemon/pidfile.ts';
import type { CommandResult, FormSpec, ListSpec } from '../repl/forms/types.ts';

export type { CommandResult } from '../repl/forms/types.ts';

export interface CommandContext {
  state: AgentState;
  provider: Provider;
  setProvider(next: Provider): void;
  clearHistory(): void;
  exit(): void;
  mcp: McpManager;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  execute(ctx: CommandContext, args: string): Promise<CommandResult> | CommandResult;
}

async function listOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function parseProviderName(name: string): { kind: 'ollama' | 'anthropic'; model: string } | null {
  const colon = name.indexOf(':');
  if (colon === -1) return null;
  const kind = name.slice(0, colon);
  const model = name.slice(colon + 1);
  if (kind !== 'ollama' && kind !== 'anthropic') return null;
  return { kind, model };
}

export const COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    description: 'List commands or show details for one',
    usage: '/help [name]',
    execute(_ctx, args) {
      const target = args.trim();
      if (target) {
        const lookup = target.startsWith('/') ? target : `/${target}`;
        const cmd = COMMANDS.find((c) => c.name === lookup);
        if (!cmd) return `unknown command: ${lookup}`;
        const usage = cmd.usage ? `\nusage: ${cmd.usage}` : '';
        return `${cmd.name} — ${cmd.description}${usage}`;
      }
      const lines = COMMANDS.map((c) => {
        const left = c.usage ?? c.name;
        return `  ${left.padEnd(22)} ${c.description}`;
      });
      return ['Commands:', ...lines].join('\n');
    },
  },
  {
    name: '/clear',
    description: 'Forget the current conversation history',
    execute(ctx) {
      ctx.clearHistory();
      return '(history cleared)';
    },
  },
  {
    name: '/model',
    description: 'List installed models or switch the active one',
    usage: '/model [name]',
    async execute(ctx, args) {
      const target = args.trim();
      const current = parseProviderName(ctx.provider.name);

      if (target) {
        return switchModel(ctx, target);
      }

      // No args → visual model picker.
      if (current?.kind === 'ollama') {
        const cfg = loadConfig().config.ollama;
        const models = await listOllamaModels(cfg.baseUrl);
        if (models.length === 0) {
          return `(could not reach Ollama at ${cfg.baseUrl})`;
        }
        const items = models.map((m) => ({
          value: m,
          label: m,
          ...(m === current.model ? { badge: '* current' } : {}),
        }));
        const list: ListSpec = {
          kind: 'list',
          title: 'Pick a model',
          items,
          onPick: async (value) => switchModel(ctx, value),
          onCancel: () => null,
        };
        return list;
      }

      // Anthropic: free-form text input.
      const form: FormSpec = {
        kind: 'form',
        title: 'Switch model',
        fields: [
          {
            kind: 'text',
            key: 'model',
            label: 'Model name',
            defaultValue: current?.model ?? '',
            placeholder: 'claude-3-5-sonnet-latest',
            required: true,
          },
        ],
        onSubmit: (v) => switchModel(ctx, v['model'] ?? ''),
        onCancel: () => null,
      };
      return form;
    },
  },
  {
    name: '/provider',
    description: 'Switch between ollama and anthropic',
    usage: '/provider [ollama|anthropic]',
    execute(ctx, args) {
      const target = args.trim().toLowerCase();
      if (target) return switchProvider(ctx, target);
      const list: ListSpec = {
        kind: 'list',
        title: 'Pick a provider',
        items: [
          {
            value: 'ollama',
            label: 'Ollama (local)',
            description: loadConfig().config.ollama.model,
            ...(ctx.provider.name.startsWith('ollama:') ? { badge: '* current' } : {}),
          },
          {
            value: 'anthropic',
            label: 'Anthropic API',
            description: loadConfig().config.anthropic.model,
            ...(ctx.provider.name.startsWith('anthropic:') ? { badge: '* current' } : {}),
          },
        ],
        onPick: (v) => switchProvider(ctx, v),
        onCancel: () => null,
      };
      return list;
    },
  },
  {
    name: '/tools',
    description: 'List registered tools',
    execute() {
      const lines = listTools().map(
        (t) => `  ${t.name.padEnd(24)} ${t.description.split('\n')[0]}`,
      );
      return ['Tools:', ...lines].join('\n');
    },
  },
  {
    name: '/status',
    description: 'Show active provider, bots, MCP, and daemon state',
    execute(ctx) {
      const paths = asteriskPaths();
      const cfgExists = existsSync(paths.configFile);
      const secretsExists = existsSync(paths.secretsFile);
      const pidStatus = statusFromPidFile(paths.pidFile);
      const loaded = loadConfig();
      const cfg = loaded.config;
      const secrets = loaded.secrets;

      const daemonLine = pidStatus.running
        ? `running · pid ${pidStatus.pid}`
        : pidStatus.stale
          ? 'not running (stale pid file)'
          : 'not running';

      const tg = cfg.bots.telegram;
      const wa = cfg.bots.whatsapp;
      const tgState = tg.enabled
        ? `enabled · ${tg.allowedUserIds.length} allowlisted ${secrets.ASTERISK_TELEGRAM_BOT_TOKEN ? '· token set' : '· ⚠ NO TOKEN'}`
        : 'disabled';
      const waState = wa.enabled
        ? `enabled · ${wa.transport}`
        : 'disabled';

      const mcpConfigured = cfg.mcpServers.length;
      const mcpConnected = ctx.mcp.servers.length;
      const mcpTools = ctx.mcp.tools.length;
      const mcpLine =
        mcpConfigured === 0
          ? 'none configured'
          : `${mcpConnected}/${mcpConfigured} connected · ${mcpTools} tool${mcpTools === 1 ? '' : 's'}`;

      const provider = parseProviderName(ctx.provider.name);
      const providerLabel =
        provider?.kind === 'ollama'
          ? `ollama · ${provider.model} · ${cfg.ollama.baseUrl}`
          : provider?.kind === 'anthropic'
            ? `anthropic · ${provider.model}`
            : ctx.provider.name;

      const configLine = cfgExists
        ? paths.configFile
        : `${paths.configFile} · using defaults (file not yet created)`;
      const secretsLine = secretsExists
        ? `${paths.secretsFile} · chmod 600`
        : `${paths.secretsFile} · not yet created`;

      return [
        `Provider   ${providerLabel}`,
        `History    ${ctx.state.history.length} message${ctx.state.history.length === 1 ? '' : 's'}`,
        `Telegram   ${tgState}`,
        `WhatsApp   ${waState}`,
        `MCP        ${mcpLine}`,
        `Daemon     ${daemonLine}`,
        '',
        `Config     ${configLine}`,
        `Secrets    ${secretsLine}`,
        `Home       ${paths.root}`,
      ].join('\n');
    },
  },
  {
    name: '/config',
    description: 'Edit configuration sections',
    usage: '/config [section]',
    execute(ctx, args) {
      const target = args.trim().toLowerCase();
      if (target) {
        const section = configSectionByKey(target);
        if (section) return openConfigSection(ctx, section);
        return `unknown config section: ${target}`;
      }
      const list: ListSpec = {
        kind: 'list',
        title: 'Edit which section?',
        items: CONFIG_SECTIONS.map((s) => ({
          value: s.key,
          label: s.label,
          description: s.summary,
        })),
        onPick: (v) => openConfigSection(ctx, configSectionByKey(v)!),
        onCancel: () => null,
      };
      return list;
    },
  },
  {
    name: '/reset',
    description: 'Clear history and reload config-driven provider',
    execute(ctx) {
      ctx.clearHistory();
      const cfg = loadConfig();
      if (cfg.config.provider === 'anthropic' && cfg.secrets.ANTHROPIC_API_KEY) {
        ctx.setProvider(
          createAnthropicProvider({
            apiKey: cfg.secrets.ANTHROPIC_API_KEY,
            model: cfg.config.anthropic.model,
          }),
        );
      } else {
        ctx.setProvider(
          createOllamaProvider({
            baseUrl: cfg.config.ollama.baseUrl,
            model: cfg.config.ollama.model,
            contextWindow: cfg.config.ollama.contextWindow,
          }),
        );
      }
      return '(reset)';
    },
  },
  {
    name: '/mcp',
    description: 'Manage MCP servers',
    usage: '/mcp [list|add|edit|remove|reload]',
    async execute(ctx, args) {
      const trimmed = args.trim();
      if (!trimmed) return mcpActionPicker(ctx);
      const [verb, ...rest] = trimmed.split(/\s+/);

      if (verb === 'list') return formatMcpList(ctx);
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
  },
  {
    name: '/quit',
    description: 'Exit the REPL',
    execute(ctx) {
      ctx.exit();
      return null;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
//  Provider / model switching
// ─────────────────────────────────────────────────────────────────────────

function switchModel(ctx: CommandContext, model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return 'no model specified';
  const current = parseProviderName(ctx.provider.name);
  if (!current) return `cannot parse current provider: ${ctx.provider.name}`;
  const cfg = loadConfig();
  if (current.kind === 'ollama') {
    ctx.setProvider(
      createOllamaProvider({
        baseUrl: cfg.config.ollama.baseUrl,
        model: trimmed,
        contextWindow: cfg.config.ollama.contextWindow,
      }),
    );
  } else {
    const apiKey = cfg.secrets.ANTHROPIC_API_KEY;
    if (!apiKey) return 'ANTHROPIC_API_KEY not set; run `asterisk configure`';
    ctx.setProvider(createAnthropicProvider({ apiKey, model: trimmed }));
  }
  return `✓ switched to ${current.kind}:${trimmed}`;
}

function switchProvider(ctx: CommandContext, target: string): string {
  const cfg = loadConfig();
  if (target === 'ollama') {
    ctx.setProvider(
      createOllamaProvider({
        baseUrl: cfg.config.ollama.baseUrl,
        model: cfg.config.ollama.model,
        contextWindow: cfg.config.ollama.contextWindow,
      }),
    );
    return `✓ switched to ollama:${cfg.config.ollama.model}`;
  }
  if (target === 'anthropic') {
    const apiKey = cfg.secrets.ANTHROPIC_API_KEY;
    if (!apiKey) return 'ANTHROPIC_API_KEY not set; run `asterisk configure`';
    ctx.setProvider(createAnthropicProvider({ apiKey, model: cfg.config.anthropic.model }));
    return `✓ switched to anthropic:${cfg.config.anthropic.model}`;
  }
  return `unknown provider: ${target} (expected ollama or anthropic)`;
}

// ─────────────────────────────────────────────────────────────────────────
//  MCP visual flows
// ─────────────────────────────────────────────────────────────────────────

function mcpActionPicker(ctx: CommandContext): ListSpec {
  return {
    kind: 'list',
    title: 'MCP servers — pick an action',
    items: [
      { value: 'list', label: 'List', description: 'show configured + connected servers' },
      { value: 'add', label: 'Add', description: 'register a new MCP server' },
      { value: 'edit', label: 'Edit', description: 'change an existing server' },
      { value: 'remove', label: 'Remove', description: 'delete a server' },
      { value: 'reload', label: 'Reload', description: 'reconnect all servers' },
    ],
    onPick: async (v): Promise<CommandResult> => {
      if (v === 'list') return formatMcpList(ctx);
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
    fields: [
      { kind: 'confirm', key: 'confirm', label: 'Are you sure?', defaultValue: 'no' },
    ],
    onSubmit: async (v) => {
      if (v['confirm'] !== 'yes') return '(kept)';
      const cfg = loadConfig();
      const before = cfg.config.mcpServers.length;
      cfg.config.mcpServers = cfg.config.mcpServers.filter(
        (s: McpServerConfig) => s.name !== name,
      );
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
    return [
      'No MCP servers configured.',
      'Use /mcp add to register one.',
    ].join('\n');
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

// ─────────────────────────────────────────────────────────────────────────
//  /config sections
// ─────────────────────────────────────────────────────────────────────────

interface ConfigSection {
  key: string;
  label: string;
  summary: string;
  open(ctx: CommandContext): FormSpec | string;
}

const CONFIG_SECTIONS: ConfigSection[] = [
  {
    key: 'provider',
    label: 'Default provider',
    summary: 'ollama or anthropic at startup',
    open() {
      const cfg = loadConfig().config;
      return {
        kind: 'form',
        title: 'Default provider',
        fields: [
          {
            kind: 'select',
            key: 'provider',
            label: 'Provider',
            options: [
              { value: 'ollama', label: 'Ollama (local)' },
              { value: 'anthropic', label: 'Anthropic API' },
            ],
            defaultValue: cfg.provider,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig().config;
          next.provider = (v['provider'] ?? next.provider) as 'ollama' | 'anthropic';
          saveConfig(next);
          return `✓ default provider set to ${next.provider} (restart REPL or use /reset to apply)`;
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'ollama',
    label: 'Ollama settings',
    summary: 'base URL, default model, context window',
    open() {
      const cfg = loadConfig().config.ollama;
      return {
        kind: 'form',
        title: 'Ollama settings',
        fields: [
          { kind: 'text', key: 'baseUrl', label: 'Base URL', defaultValue: cfg.baseUrl, required: true },
          { kind: 'text', key: 'model', label: 'Default model', defaultValue: cfg.model, required: true },
          {
            kind: 'text',
            key: 'contextWindow',
            label: 'Context window (tokens)',
            defaultValue: String(cfg.contextWindow),
            required: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig().config;
          next.ollama.baseUrl = (v['baseUrl'] ?? next.ollama.baseUrl).trim();
          next.ollama.model = (v['model'] ?? next.ollama.model).trim();
          const ctxN = Number.parseInt(v['contextWindow'] ?? '', 10);
          if (Number.isFinite(ctxN) && ctxN > 0) next.ollama.contextWindow = ctxN;
          saveConfig(next);
          return '✓ Ollama settings saved (use /reset to apply)';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'anthropic',
    label: 'Anthropic settings',
    summary: 'default model + API key (chmod-600 secrets file)',
    open() {
      const cfg = loadConfig();
      return {
        kind: 'form',
        title: 'Anthropic settings',
        fields: [
          {
            kind: 'text',
            key: 'model',
            label: 'Default model',
            defaultValue: cfg.config.anthropic.model,
            required: true,
          },
          {
            kind: 'text',
            key: 'apiKey',
            label: 'API key (leave empty to keep existing)',
            placeholder: cfg.secrets.ANTHROPIC_API_KEY ? '(set)' : '(unset)',
            secret: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig();
          next.config.anthropic.model = (v['model'] ?? next.config.anthropic.model).trim();
          saveConfig(next.config);
          const newKey = (v['apiKey'] ?? '').trim();
          if (newKey) {
            saveSecrets({ ...next.secrets, ANTHROPIC_API_KEY: newKey });
            return '✓ Anthropic settings saved (key updated)';
          }
          return '✓ Anthropic settings saved';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'telegram',
    label: 'Telegram bot',
    summary: 'enable, allowed user IDs, bot token',
    open() {
      const cfg = loadConfig();
      return {
        kind: 'form',
        title: 'Telegram bot',
        fields: [
          {
            kind: 'confirm',
            key: 'enabled',
            label: 'Enable Telegram bot?',
            defaultValue: cfg.config.bots.telegram.enabled ? 'yes' : 'no',
          },
          {
            kind: 'text',
            key: 'allowedUserIds',
            label: 'Allowed Telegram user IDs (comma-separated)',
            defaultValue: cfg.config.bots.telegram.allowedUserIds.join(','),
          },
          {
            kind: 'text',
            key: 'token',
            label: 'Bot token (leave empty to keep existing)',
            placeholder: cfg.secrets.ASTERISK_TELEGRAM_BOT_TOKEN ? '(set)' : '(unset)',
            secret: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig();
          next.config.bots.telegram.enabled = (v['enabled'] ?? 'no') === 'yes';
          next.config.bots.telegram.allowedUserIds = (v['allowedUserIds'] ?? '')
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          saveConfig(next.config);
          const token = (v['token'] ?? '').trim();
          if (token) {
            saveSecrets({ ...next.secrets, ASTERISK_TELEGRAM_BOT_TOKEN: token });
            return '✓ Telegram settings saved (token updated; restart daemon to apply)';
          }
          return '✓ Telegram settings saved (restart daemon to apply)';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
  {
    key: 'daemon',
    label: 'Daemon',
    summary: 'log level, heartbeat interval',
    open() {
      const cfg = loadConfig().config.daemon;
      return {
        kind: 'form',
        title: 'Daemon settings',
        fields: [
          {
            kind: 'select',
            key: 'logLevel',
            label: 'Log level',
            options: [
              { value: 'fatal', label: 'fatal' },
              { value: 'error', label: 'error' },
              { value: 'warn', label: 'warn' },
              { value: 'info', label: 'info' },
              { value: 'debug', label: 'debug' },
              { value: 'trace', label: 'trace' },
            ],
            defaultValue: cfg.logLevel,
          },
          {
            kind: 'text',
            key: 'heartbeatSeconds',
            label: 'Heartbeat (seconds)',
            defaultValue: String(cfg.heartbeatSeconds),
            required: true,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig().config;
          next.daemon.logLevel = (v['logLevel'] ?? next.daemon.logLevel) as
            | 'fatal'
            | 'error'
            | 'warn'
            | 'info'
            | 'debug'
            | 'trace';
          const hb = Number.parseInt(v['heartbeatSeconds'] ?? '', 10);
          if (Number.isFinite(hb) && hb >= 5) next.daemon.heartbeatSeconds = hb;
          saveConfig(next);
          return '✓ Daemon settings saved (restart daemon to apply)';
        },
        onCancel: () => '(cancelled)',
      };
    },
  },
];

function configSectionByKey(key: string): ConfigSection | undefined {
  return CONFIG_SECTIONS.find((s) => s.key === key);
}

function openConfigSection(ctx: CommandContext, section: ConfigSection): CommandResult {
  return section.open(ctx);
}

export function lookupCommand(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = space === -1 ? input : input.slice(0, space);
  const args = space === -1 ? '' : input.slice(space + 1);
  const command = COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}
