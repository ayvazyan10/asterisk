// Slash-command registry. Commands receive a context with mutators (set
// provider, clear history, exit), do their work, and return a string to
// render in the transcript or null to suppress output.

import { existsSync } from 'node:fs';

import type { AgentState } from '../agent/loop.ts';
import { loadConfig, saveConfig } from '../config/load.ts';
import type { McpServerConfig } from '../config/schema.ts';
import type { McpManager } from '../mcp/manager.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { listTools, setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { statusFromPidFile } from '../daemon/pidfile.ts';

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
  execute(ctx: CommandContext, args: string): Promise<string | null> | string | null;
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

      if (!target) {
        const lines = [`active: ${ctx.provider.name}`];
        if (current?.kind === 'ollama') {
          const cfg = loadConfig().config.ollama;
          const models = await listOllamaModels(cfg.baseUrl);
          if (models.length === 0) {
            lines.push('(could not reach Ollama at ' + cfg.baseUrl + ')');
          } else {
            lines.push('installed Ollama models:');
            for (const m of models) {
              const marker = m === current.model ? ' *' : '  ';
              lines.push(`${marker} ${m}`);
            }
          }
        } else {
          lines.push('Pass a model name to switch, e.g. /model claude-3-5-sonnet-latest');
        }
        return lines.join('\n');
      }

      if (!current) return `cannot parse current provider: ${ctx.provider.name}`;
      const cfg = loadConfig();
      if (current.kind === 'ollama') {
        ctx.setProvider(
          createOllamaProvider({
            baseUrl: cfg.config.ollama.baseUrl,
            model: target,
            contextWindow: cfg.config.ollama.contextWindow,
          }),
        );
      } else {
        const apiKey = cfg.secrets.ANTHROPIC_API_KEY;
        if (!apiKey) return 'ANTHROPIC_API_KEY not set; run `asterisk configure`';
        ctx.setProvider(createAnthropicProvider({ apiKey, model: target }));
      }
      return `switched to ${current.kind}:${target}`;
    },
  },
  {
    name: '/provider',
    description: 'Switch between ollama and anthropic',
    usage: '/provider [ollama|anthropic]',
    execute(ctx, args) {
      const target = args.trim().toLowerCase();
      if (!target) return `active provider: ${ctx.provider.name}`;
      const cfg = loadConfig();
      if (target === 'ollama') {
        ctx.setProvider(
          createOllamaProvider({
            baseUrl: cfg.config.ollama.baseUrl,
            model: cfg.config.ollama.model,
            contextWindow: cfg.config.ollama.contextWindow,
          }),
        );
        return `switched to ollama:${cfg.config.ollama.model}`;
      }
      if (target === 'anthropic') {
        const apiKey = cfg.secrets.ANTHROPIC_API_KEY;
        if (!apiKey) return 'ANTHROPIC_API_KEY not set; run `asterisk configure`';
        ctx.setProvider(createAnthropicProvider({ apiKey, model: cfg.config.anthropic.model }));
        return `switched to anthropic:${cfg.config.anthropic.model}`;
      }
      return `unknown provider: ${target} (expected ollama or anthropic)`;
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
    description: 'Show provider, daemon, and config status',
    execute(ctx) {
      const paths = asteriskPaths();
      const cfgExists = existsSync(paths.configFile);
      const secretsExists = existsSync(paths.secretsFile);
      const pidStatus = statusFromPidFile(paths.pidFile);
      const daemonLine = pidStatus.running
        ? `running (pid ${pidStatus.pid})`
        : pidStatus.stale
          ? 'not running (stale pid file)'
          : 'not running';
      return [
        `provider: ${ctx.provider.name}`,
        `history:  ${ctx.state.history.length} messages`,
        `config:   ${cfgExists ? paths.configFile : '(none — run `asterisk configure`)'}`,
        `secrets:  ${secretsExists ? paths.secretsFile + ' (chmod 600)' : '(none)'}`,
        `daemon:   ${daemonLine}`,
        `home:     ${paths.root}`,
      ].join('\n');
    },
  },
  {
    name: '/config',
    description: 'Show or open the config file',
    usage: '/config [edit]',
    execute(_ctx, args) {
      const paths = asteriskPaths();
      if (args.trim() === 'edit') {
        const editor = process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'nano';
        return `to edit, run from another terminal: ${editor} ${paths.configFile}`;
      }
      return `config: ${paths.configFile}\n(run \`asterisk configure\` for the wizard, or \`/config edit\` for a hint)`;
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
    description: 'List, add, remove, or reload MCP servers',
    usage: '/mcp [list|add|remove|reload] ...',
    async execute(ctx, args) {
      const trimmed = args.trim();
      if (!trimmed || trimmed === 'list') return formatMcpList(ctx);
      const [verb, ...rest] = trimmed.split(/\s+/);

      if (verb === 'reload') {
        const result = await ctx.mcp.reload();
        applyMcpToolsToRegistry(ctx);
        const lines = [`reloaded ${ctx.mcp.servers.length} MCP server(s)`];
        for (const c of result.connected) lines.push(`  ✓ ${c}`);
        for (const f of result.failed) lines.push(`  ✗ ${f.name}: ${f.error}`);
        return lines.join('\n');
      }

      if (verb === 'remove') {
        const name = rest[0];
        if (!name) return 'usage: /mcp remove NAME';
        const cfg = loadConfig();
        const before = cfg.config.mcpServers.length;
        cfg.config.mcpServers = cfg.config.mcpServers.filter(
          (s: McpServerConfig) => s.name !== name,
        );
        if (cfg.config.mcpServers.length === before) return `no MCP server named "${name}"`;
        saveConfig(cfg.config);
        const result = await ctx.mcp.reload();
        applyMcpToolsToRegistry(ctx);
        return [`removed "${name}"`, `now connected: ${result.connected.length}`].join('\n');
      }

      if (verb === 'add') {
        const transport = rest[0];
        if (transport === 'stdio') {
          const [, name, command, ...spawnArgs] = rest;
          if (!name || !command) {
            return 'usage: /mcp add stdio NAME COMMAND [ARGS...]';
          }
          return addServer(ctx, {
            name,
            transport: 'stdio',
            command,
            args: spawnArgs,
            env: {},
            enabled: true,
          });
        }
        if (transport === 'http') {
          const [, name, url] = rest;
          if (!name || !url) return 'usage: /mcp add http NAME URL';
          return addServer(ctx, {
            name,
            transport: 'http',
            url,
            headers: {},
            enabled: true,
          });
        }
        return 'usage: /mcp add stdio|http ...';
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

function formatMcpList(ctx: CommandContext): string {
  const cfg = loadConfig().config;
  const configured = cfg.mcpServers;
  const connected = new Set(ctx.mcp.servers.map((s) => s.config.name));
  if (configured.length === 0) {
    return [
      'No MCP servers configured.',
      'Add one with:',
      '  /mcp add stdio NAME COMMAND [ARGS...]',
      '  /mcp add http  NAME URL',
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
  if (tools.length > 0) lines.push(`(${tools.length} MCP tool${tools.length === 1 ? '' : 's'} available)`);
  return lines.join('\n');
}

function applyMcpToolsToRegistry(ctx: CommandContext): void {
  setExtraTools(ctx.mcp.tools);
}

async function addServer(ctx: CommandContext, server: McpServerConfig): Promise<string> {
  const cfg = loadConfig();
  if (cfg.config.mcpServers.some((s: McpServerConfig) => s.name === server.name)) {
    return `MCP server "${server.name}" already exists`;
  }
  cfg.config.mcpServers.push(server);
  saveConfig(cfg.config);
  const result = await ctx.mcp.reload();
  applyMcpToolsToRegistry(ctx);
  const ok = result.connected.find((s) => s.startsWith(`${server.name} `));
  if (ok) return `added "${server.name}" — ${ok}`;
  const failed = result.failed.find((f) => f.name === server.name);
  if (failed) return `added "${server.name}" but connect failed: ${failed.error}`;
  return `added "${server.name}"`;
}

export function lookupCommand(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = space === -1 ? input : input.slice(0, space);
  const args = space === -1 ? '' : input.slice(space + 1);
  const command = COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}
