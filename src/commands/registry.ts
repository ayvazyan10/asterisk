// Slash-command registry. Commands receive a context with mutators (set
// provider, clear history, exit), do their work, and return a CommandResult:
// a string to render, null for no output, or a FormSpec / ListSpec to render
// an interactive modal in the REPL.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { runWithSession } from '../agent/context.ts';
import type { AgentState } from '../agent/loop.ts';
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from '../agent/persistence.ts';
import { loadAgents } from '../agents/loader.ts';
import { loadConfig, saveConfig, saveSecrets } from '../config/load.ts';
import type { HookConfig, McpServerConfig } from '../config/schema.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { statusFromPidFile } from '../daemon/pidfile.ts';
import type { McpManager } from '../mcp/manager.ts';
import { OUTPUT_STYLES, findOutputStyle } from '../output-styles/styles.ts';
import { chooseProvider } from '../providers/factory.ts';
import type { CommandResult, FormSpec, ListSpec } from '../repl/forms/types.ts';
import { loadRules } from '../rules/loader.ts';
import { type Skill, loadSkills } from '../skills/loader.ts';
import { DEFAULT_SOUL_TEMPLATE, type Soul, loadSouls } from '../soul/loader.ts';
import { codeIntelTool } from '../tools/code-intel.ts';
import { isPlanMode, setPlanMode } from '../tools/planmode.ts';
import { listTools, setExtraTools } from '../tools/registry.ts';
import { _allTasks } from '../tools/tasks.ts';
import type { Provider } from '../types/messages.ts';
import { getVersion } from '../version.ts';

export type { CommandResult } from '../repl/forms/types.ts';

export interface CommandContext {
  state: AgentState;
  provider: Provider;
  setProvider(next: Provider): void;
  clearHistory(): void;
  exit(): void;
  mcp: McpManager;
  /** Inject text into the REPL's input as if the user typed it (used by /skill). */
  injectInput?(text: string): void;
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

// Static fallback used when /v1/models can't be reached (no key, network
// error, or the endpoint is throttled). Ordered newest-first so the visible
// default lands on a current model.
// Retired ids are omitted deliberately — offering one only produces a 404 at
// the first request. Sonnet 3.5 retired 2025-10-28; Sonnet 3.7 and Haiku 3.5
// retired 2026-02-19.
const ANTHROPIC_FALLBACK_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
];

interface AnthropicModel {
  id: string;
  label: string;
}

async function listAnthropicModels(apiKey: string): Promise<AnthropicModel[]> {
  if (!apiKey) return [...ANTHROPIC_FALLBACK_MODELS];
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [...ANTHROPIC_FALLBACK_MODELS];
    const data = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string }>;
    };
    const fetched = (data.data ?? []).map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
    }));
    return fetched.length > 0 ? fetched : [...ANTHROPIC_FALLBACK_MODELS];
  } catch {
    return [...ANTHROPIC_FALLBACK_MODELS];
  }
}

type ProviderKind = 'ollama' | 'openai-compatible' | 'anthropic';

/** Splits `<kind>:<model>`; model ids may contain colons, so only the first splits. */
function parseProviderName(name: string): { kind: ProviderKind; model: string } | null {
  const colon = name.indexOf(':');
  if (colon === -1) return null;
  const kind = name.slice(0, colon);
  const model = name.slice(colon + 1);
  if (kind !== 'ollama' && kind !== 'openai-compatible' && kind !== 'anthropic') return null;
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

      // Anthropic: fetch the live list from /v1/models when we have a key.
      const apiKey = loadConfig().secrets.ANTHROPIC_API_KEY ?? '';
      const models = await listAnthropicModels(apiKey);
      const items = models.map((m) => ({
        value: m.id,
        label: m.label,
        description: m.label === m.id ? undefined : m.id,
        ...(m.id === current?.model ? { badge: '* current' } : {}),
      }));
      const list: ListSpec = {
        kind: 'list',
        title: apiKey ? 'Pick an Anthropic model' : 'Pick an Anthropic model (offline list)',
        items: items.map((i) => {
          const out: { value: string; label: string; description?: string; badge?: string } = {
            value: i.value,
            label: i.label,
          };
          if (i.description !== undefined) out.description = i.description;
          if (i.badge !== undefined) out.badge = i.badge;
          return out;
        }),
        onPick: async (value) => switchModel(ctx, value),
        onCancel: () => null,
      };
      return list;
    },
  },
  {
    name: '/provider',
    description: 'Switch between ollama, openai-compatible, and anthropic',
    usage: '/provider [ollama|openai-compatible|anthropic]',
    execute(ctx, args) {
      const target = args.trim().toLowerCase();
      if (target) return switchProvider(ctx, target);
      const cfg = loadConfig().config;
      const list: ListSpec = {
        kind: 'list',
        title: 'Pick a provider',
        items: [
          {
            value: 'ollama',
            label: 'Ollama (local)',
            description: cfg.ollama.model,
            ...(ctx.provider.name.startsWith('ollama:') ? { badge: '* current' } : {}),
          },
          {
            value: 'openai-compatible',
            label: 'OpenAI-compatible (llama.cpp, LM Studio, vLLM, …)',
            description: `${cfg.openaiCompatible.model || '(server default)'} @ ${cfg.openaiCompatible.baseUrl}`,
            ...(ctx.provider.name.startsWith('openai-compatible:') ? { badge: '* current' } : {}),
          },
          {
            value: 'anthropic',
            label: 'Anthropic API',
            description: cfg.anthropic.model,
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
      const waState = wa.enabled ? `enabled · ${wa.transport}` : 'disabled';

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
      const chosen = chooseProvider(loadConfig());
      ctx.setProvider(chosen.provider);
      return chosen.fallbackReason
        ? `(reset — ${chosen.fallbackReason}; using ${chosen.kind})`
        : `(reset — provider ${chosen.kind})`;
    },
  },
  {
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
  },
  {
    name: '/soul',
    description: 'Show or initialise the SOUL.md persona file',
    usage: '/soul [show|init|where]',
    async execute(_ctx, args) {
      const verb = args.trim().toLowerCase();
      if (verb === 'where' || verb === 'paths') return formatSoulPaths();
      if (verb === 'init') return await soulInit();
      // default + 'show': render what's loaded — including any per-session
      // soul that the REPL turn would pick up.
      const session = { id: 'repl', scope: 'repl' as const };
      const souls = loadSouls(process.cwd(), session);
      if (souls.length === 0) {
        return [
          'No SOUL.md loaded.',
          '',
          'Create one to give the agent a persona + tell it about you:',
          '  ~/.asterisk/SOUL.md            (user-global, applies everywhere)',
          `  ${process.cwd()}/.asterisk/SOUL.md   (project-local)`,
          `  ${process.cwd()}/SOUL.md       (project root marker)`,
          '',
          'Run /soul init to drop a starter template at ~/.asterisk/SOUL.md.',
        ].join('\n');
      }
      const tag = (s: Soul): string =>
        s.scope === 'user' ? 'user   ' : s.scope === 'session' ? 'session' : 'project';
      const lines: string[] = [`Soul · ${souls.length} loaded`];
      for (const s of souls) {
        lines.push(`  ${tag(s)}  ${s.path}  (${s.content.length} chars)`);
      }
      lines.push('');
      lines.push('--- content ---');
      for (const s of souls) {
        lines.push('');
        lines.push(`# ${s.scope}: ${s.path}`);
        lines.push(s.content);
      }
      return lines.join('\n');
    },
  },
  {
    name: '/rules',
    description: 'List the rules currently loaded into the system prompt',
    execute() {
      const rules = loadRules();
      if (rules.length === 0) {
        return [
          'No rules loaded.',
          '',
          'Drop markdown files into one of these locations:',
          '  ~/.asterisk/rules/*.md            (user-global)',
          `  ${process.cwd()}/.asterisk/rules/*.md  (project-local)`,
          `  ${process.cwd()}/ASTERISK.md          (project root)`,
        ].join('\n');
      }
      const total = rules.reduce((sum, r) => sum + r.content.length, 0);
      const lines = [
        `Rules  ${rules.length} file${rules.length === 1 ? '' : 's'} · ${total} chars total`,
      ];
      for (const r of rules) {
        lines.push(
          `  ${r.scope === 'user' ? 'user   ' : 'project'}  ${r.name}  (${r.content.length} chars)`,
        );
        lines.push(`    ${r.path}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: '/skills',
    description: 'List installed skills',
    execute() {
      const skills = loadSkills();
      if (skills.length === 0) {
        return [
          'No skills installed.',
          '',
          'Create one at:',
          '  ~/.asterisk/skills/<name>/SKILL.md            (user-global)',
          `  ${process.cwd()}/.asterisk/skills/<name>/SKILL.md   (project-local)`,
          '',
          'Format:',
          '  ---',
          '  name: code-review',
          '  description: Review the staged diff for bugs and style',
          '  ---',
          '  Look at the staged changes via `git diff --staged`...',
        ].join('\n');
      }
      const lines = [`Skills  ${skills.length} loaded`];
      for (const s of skills) {
        const tag = s.scope === 'bundled' ? 'bundled' : s.scope === 'user' ? 'user   ' : 'project';
        lines.push(`  ${tag}  ${s.name}`);
        if (s.description) lines.push(`    ${s.description}`);
      }
      lines.push('');
      lines.push('Run one with /skill');
      return lines.join('\n');
    },
  },
  {
    name: '/skill',
    description: 'Run a skill by name',
    usage: '/skill [name]',
    execute(ctx, args) {
      const skills = loadSkills();
      if (skills.length === 0) return 'No skills installed. /skills shows how to add one.';
      const target = args.trim();
      if (target) {
        const skill = skills.find((s) => s.name === target);
        if (!skill) return `unknown skill: ${target}`;
        return runSkill(ctx, skill);
      }
      const list: ListSpec = {
        kind: 'list',
        title: 'Pick a skill to run',
        items: skills.map((s) => {
          const item: { value: string; label: string; description?: string; badge?: string } = {
            value: s.name,
            label: s.name,
          };
          if (s.description) item.description = s.description;
          if (s.scope === 'project') item.badge = '* project';
          else if (s.scope === 'bundled') item.badge = '* bundled';
          return item;
        }),
        onPick: (name) => {
          const skill = skills.find((s) => s.name === name);
          if (!skill) return `unknown skill: ${name}`;
          return runSkill(ctx, skill);
        },
        onCancel: () => null,
      };
      return list;
    },
  },
  {
    name: '/hooks',
    description: 'Manage agent-loop lifecycle hooks',
    usage: '/hooks [list|add|remove|toggle]',
    async execute(ctx, args) {
      const trimmed = args.trim();
      if (!trimmed) return hooksActionPicker(ctx);
      const [verb, ...rest] = trimmed.split(/\s+/);
      if (verb === 'list') return formatHookList();
      if (verb === 'add') return hooksAddForm();
      if (verb === 'remove') {
        const name = rest[0];
        if (!name) return hooksRemovePicker();
        return removeHookByName(name);
      }
      if (verb === 'toggle') {
        const name = rest[0];
        if (!name) return hooksTogglePicker();
        return toggleHookByName(name);
      }
      return `unknown /hooks verb: ${verb}`;
    },
  },
  {
    name: '/agents',
    description: 'List specialised sub-agent types you can dispatch via the Agent tool',
    execute() {
      const agents = loadAgents();
      const lines = [`Agents · ${agents.length} available`];
      const tag = (a: { scope: string }): string =>
        a.scope === 'user' ? 'user   ' : a.scope === 'project' ? 'project' : 'bundled';
      for (const a of agents) {
        const restricted = a.allowedTools ? ` · ${a.allowedTools.length} tools` : '';
        lines.push(`  ${tag(a)}  ${a.name.padEnd(28)} ${a.description}${restricted}`);
      }
      lines.push('');
      lines.push('Usage: the agent calls Agent({ prompt: "…", subagent_type: "<name>" }).');
      lines.push('Add your own at ~/.asterisk/agents/<name>.md or .asterisk/agents/<name>.md.');
      return lines.join('\n');
    },
  },
  {
    name: '/output-style',
    description: 'Switch reply style — default | concise | explanatory | learning',
    usage: '/output-style [name]',
    async execute(_ctx, args) {
      const requested = args.trim().toLowerCase();
      if (!requested) {
        return {
          kind: 'list',
          title: 'Output style',
          items: OUTPUT_STYLES.map((s) => ({
            value: s.name,
            label: s.name,
            description: s.description,
          })),
          onPick: (v: string) => applyOutputStyle(v),
        };
      }
      return applyOutputStyle(requested);
    },
  },
  {
    name: '/plan',
    description: 'Toggle Plan Mode — read-only research mode (no Edit/Write/Bash)',
    execute() {
      // Plan mode is per-session; the REPL session is "repl".
      return runWithSession({ id: 'repl', scope: 'repl' }, async () => {
        const next = !isPlanMode();
        setPlanMode(next);
        return next
          ? '✓ Plan Mode ON · only read-only tools available until /plan again.'
          : '✓ Plan Mode OFF · all tools re-enabled.';
      });
    },
  },
  {
    name: '/tasks',
    description: "List the agent's in-flight tasks for this session",
    execute() {
      return runWithSession({ id: 'repl', scope: 'repl' }, async () => {
        const tasks = _allTasks();
        if (tasks.length === 0) {
          return '(no tasks · the agent creates them as it tackles multi-step work)';
        }
        const icon = (s: string): string =>
          s === 'completed' ? '✓' : s === 'in_progress' ? '◐' : s === 'cancelled' ? '✗' : '○';
        const lines = [`Tasks · ${tasks.length} total`];
        for (const t of tasks) {
          const desc = t.description ? ` — ${t.description}` : '';
          lines.push(`  ${icon(t.status)} #${t.id}  ${t.title}${desc}`);
        }
        return lines.join('\n');
      });
    },
  },
  {
    name: '/sessions',
    description: 'List saved conversations',
    execute() {
      return formatSessions();
    },
  },
  {
    name: '/resume',
    description: 'Resume a saved conversation',
    usage: '/resume [id]',
    execute(ctx, args) {
      const id = args.trim();
      if (!id) return resumePicker(ctx);
      return resumeConversation(ctx, id);
    },
  },
  {
    name: '/forget',
    description: 'Delete a saved conversation',
    usage: '/forget [id]',
    execute(_ctx, args) {
      const id = args.trim();
      if (!id) return forgetPicker();
      return forgetConversation(id);
    },
  },
  {
    name: '/diff',
    description: 'Show a structured git diff summary',
    usage: '/diff [staged|all|path]',
    execute(_ctx, args) {
      return formatDiffCommand(args.trim());
    },
  },
  {
    name: '/review',
    description: 'Review current git changes for risk patterns',
    usage: '/review [staged|all|path]',
    execute(_ctx, args) {
      return formatDiffCommand(args.trim(), true);
    },
  },
  {
    name: '/code',
    description: 'Code intelligence: symbols, definitions, references, diagnostics',
    usage: '/code [symbols|def|refs|diagnostics] [query|file line character]',
    async execute(_ctx, args) {
      return runCodeCommand(args.trim());
    },
  },
  {
    name: '/doctor',
    description: 'Run diagnostics on Asterisk environment',
    async execute(ctx) {
      const lines: string[] = ['Asterisk diagnostics', ''];
      const paths = asteriskPaths();

      // Provider
      const current = parseProviderName(ctx.provider.name);
      lines.push(`Provider     ${ctx.provider.name}`);

      // Ollama connectivity
      try {
        const res = await fetch(
          `${loadConfig().config.ollama.baseUrl.replace(/\/$/, '')}/api/tags`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (res.ok) {
          const data = (await res.json()) as { models?: Array<{ name: string }> };
          const count = data.models?.length ?? 0;
          lines.push(
            `  ✓ Ollama     reachable · ${count} model${count === 1 ? '' : 's'} installed`,
          );
        } else {
          lines.push(`  ✗ Ollama     HTTP ${res.status}`);
        }
      } catch {
        lines.push(`  ✗ Ollama     unreachable at ${loadConfig().config.ollama.baseUrl}`);
      }

      // Anthropic key
      const apiKey = loadConfig().secrets.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            signal: AbortSignal.timeout(5000),
          });
          lines.push(
            res.ok ? '  ✓ Anthropic  API key valid' : `  ✗ Anthropic  API returned ${res.status}`,
          );
        } catch {
          lines.push('  ✗ Anthropic  API unreachable');
        }
      } else {
        lines.push('  · Anthropic  no API key set');
      }

      lines.push('');

      // System tools
      const { execSync } = await import('node:child_process');
      const checkBin = (name: string, cmd: string): string => {
        try {
          const ver = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
          return `  ✓ ${name.padEnd(12)} ${ver}`;
        } catch {
          return `  ✗ ${name.padEnd(12)} not found`;
        }
      };
      lines.push('System tools');
      lines.push(checkBin('git', 'git --version'));
      lines.push(checkBin('rg', 'rg --version'));
      lines.push(checkBin('bun', 'bun --version'));
      lines.push(checkBin('node', 'node --version'));

      // Playwright
      try {
        execSync('npx playwright --version 2>/dev/null || bunx playwright --version 2>/dev/null', {
          encoding: 'utf8',
          timeout: 5000,
        });
        lines.push('  ✓ playwright  installed');
      } catch {
        lines.push('  · playwright  not found (browser tools will fail)');
      }

      lines.push('');

      // MCP
      const mcpCfg = loadConfig().config.mcpServers;
      const mcpConnected = ctx.mcp.servers.length;
      const mcpTools = ctx.mcp.tools.length;
      lines.push(`MCP          ${mcpConnected}/${mcpCfg.length} servers · ${mcpTools} tools`);

      // Config files
      lines.push('');
      lines.push('Config files');
      lines.push(
        existsSync(paths.configFile)
          ? `  ✓ config     ${paths.configFile}`
          : `  · config     ${paths.configFile} (using defaults)`,
      );
      lines.push(
        existsSync(paths.secretsFile)
          ? `  ✓ secrets    ${paths.secretsFile}`
          : `  · secrets    ${paths.secretsFile} (not created)`,
      );

      // Daemon
      const pid = statusFromPidFile(paths.pidFile);
      lines.push('');
      lines.push(
        pid.running ? `Daemon       running · pid ${pid.pid}` : 'Daemon       not running',
      );

      // History
      lines.push(`History      ${ctx.state.history.length} messages`);

      return lines.join('\n');
    },
  },
  {
    name: '/update',
    description: 'Check for updates or self-update to the latest version',
    usage: '/update [check]',
    async execute(_ctx, args) {
      const verb = args.trim().toLowerCase();
      const installDir =
        process.env['ASTERISK_INSTALL_DIR'] ??
        `${process.env['HOME'] ?? '~'}/.local/share/asterisk`;
      const branch = process.env['ASTERISK_BRANCH'] ?? 'master';

      const { execSync } = await import('node:child_process');
      const run = (cmd: string): string =>
        execSync(cmd, { cwd: installDir, encoding: 'utf8', timeout: 30_000 }).trim();

      try {
        run('git rev-parse --git-dir');
      } catch {
        return `✗ ${installDir} is not a git repository. Run install.sh first.`;
      }

      const currentVersion = getVersion();
      const localHead = run('git rev-parse HEAD').slice(0, 10);

      try {
        run(`git fetch --tags origin ${branch}`);
      } catch {
        return '✗ git fetch failed — check your network connection.';
      }

      const remoteHead = run(`git rev-parse origin/${branch}`).slice(0, 10);

      if (localHead === remoteHead) {
        return `✓ Already up to date — v${currentVersion} (${localHead})`;
      }

      const commitCount = run(`git rev-list HEAD..origin/${branch} --count`);
      const changelog = run(`git log HEAD..origin/${branch} --oneline --no-decorate -15`);

      if (verb === 'check') {
        const lines = [
          `Update available: ${commitCount} new commit${commitCount === '1' ? '' : 's'}`,
          `  current: v${currentVersion} (${localHead})`,
          `  latest:  ${remoteHead}`,
          '',
          'Changelog:',
          ...changelog
            .split('\n')
            .filter(Boolean)
            .map((l) => `  ${l}`),
          '',
          'Run /update to apply, or `asterisk update` from the terminal.',
        ];
        return lines.join('\n');
      }

      try {
        run(`git checkout -q ${branch}`);
        run(`git reset --hard origin/${branch}`);
      } catch {
        return '✗ git reset failed.';
      }

      try {
        run('bun install --silent');
      } catch {
        return '✗ bun install failed after source update.';
      }

      try {
        run('bun run build');
      } catch {
        return '✗ bun run build failed after source update.';
      }

      const { readFileSync } = await import('node:fs');
      let newVersion = currentVersion;
      try {
        const pkg = JSON.parse(readFileSync(`${installDir}/package.json`, 'utf8'));
        newVersion = pkg.version ?? currentVersion;
      } catch {
        /* keep current */
      }

      const lines = [
        `✓ Updated: v${currentVersion} → v${newVersion} (${remoteHead})`,
        `  ${commitCount} commit${commitCount === '1' ? '' : 's'} applied`,
        '',
        'Changelog:',
        ...changelog
          .split('\n')
          .filter(Boolean)
          .map((l) => `  ${l}`),
        '',
        'Restart the REPL (/quit + asterisk) to use the new version.',
      ];
      return lines.join('\n');
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

function applyOutputStyle(name: string): string {
  const next = findOutputStyle(name);
  if (!next) {
    const valid = OUTPUT_STYLES.map((s) => s.name).join(' · ');
    return `unknown output style "${name}". Valid: ${valid}`;
  }
  const cfg = loadConfig().config;
  cfg.outputStyle = next.name;
  saveConfig(cfg);
  return `✓ output style set to "${next.name}" — ${next.description}\n  (applies on the next turn)`;
}

function runSkill(ctx: CommandContext, skill: Skill): string {
  if (ctx.injectInput) {
    ctx.injectInput(skill.prompt);
    return `✓ skill "${skill.name}" loaded into the input — press Enter to run`;
  }
  return `Skill: ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${skill.prompt}`;
}

function formatSessions(): string {
  const sessions = listConversations();
  if (sessions.length === 0) return '(no saved conversations)';
  const lines = [`Saved conversations · ${sessions.length}`];
  for (const s of sessions.slice(0, 40)) {
    lines.push(
      `  ${s.id.padEnd(28)} ${new Date(s.updatedAt).toLocaleString()} · ${s.messageCount} messages`,
    );
  }
  if (sessions.length > 40) lines.push(`  ... ${sessions.length - 40} more`);
  lines.push('');
  lines.push('Use /resume <id> or /forget <id>. The REPL auto-saves as "repl".');
  return lines.join('\n');
}

function resumePicker(ctx: CommandContext): ListSpec {
  const sessions = listConversations();
  return {
    kind: 'list',
    title: 'Resume which conversation?',
    items: sessions.map((s) => ({
      value: s.id,
      label: s.id,
      description: `${new Date(s.updatedAt).toLocaleString()} · ${s.messageCount} messages`,
    })),
    emptyMessage: 'No saved conversations.',
    onPick: (id) => resumeConversation(ctx, id),
    onCancel: () => null,
  };
}

function resumeConversation(ctx: CommandContext, id: string): string {
  const messages = loadConversation(id);
  if (messages.length === 0) return `no saved conversation named "${id}"`;
  ctx.state.history.length = 0;
  ctx.state.history.push(...messages);
  saveConversation('repl', ctx.state.history);
  return `✓ resumed "${id}" · ${messages.length} messages loaded`;
}

function forgetPicker(): ListSpec {
  const sessions = listConversations();
  return {
    kind: 'list',
    title: 'Forget which conversation?',
    items: sessions.map((s) => ({
      value: s.id,
      label: s.id,
      description: `${new Date(s.updatedAt).toLocaleString()} · ${s.messageCount} messages`,
    })),
    emptyMessage: 'No saved conversations.',
    onPick: (id) => forgetConversation(id),
    onCancel: () => null,
  };
}

function forgetConversation(id: string): string {
  return deleteConversation(id)
    ? `✓ deleted saved conversation "${id}"`
    : `no saved conversation named "${id}"`;
}

function formatDiffCommand(raw: string, review = false): string {
  const { mode, path } = parseDiffArgs(raw);
  const args = ['diff', '--no-ext-diff', '--stat'];
  if (mode === 'staged') args.push('--staged');
  if (mode === 'all') args.push('HEAD');
  if (path) args.push('--', path);

  const patchArgs = ['diff', '--no-ext-diff', '--unified=80'];
  if (mode === 'staged') patchArgs.push('--staged');
  if (mode === 'all') patchArgs.push('HEAD');
  if (path) patchArgs.push('--', path);

  try {
    const stat = execSync(`git ${shellJoin(args)}`, { encoding: 'utf8', timeout: 10000 }).trim();
    const patch = execSync(`git ${shellJoin(patchArgs)}`, { encoding: 'utf8', timeout: 10000 });
    if (!patch.trim()) return '(no changes)';
    if (!review) return [stat || 'Diff', '', truncate(patch, 50000)].join('\n');
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = patch
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const hints = reviewHints(patch);
    return [
      `Review · ${mode}${path ? ` · ${path}` : ''} · +${added} / -${removed}`,
      '',
      stat,
      '',
      'Risk hints:',
      ...(hints.length
        ? hints.map((h) => `  ${h}`)
        : ['  No obvious high-signal risk patterns found.']),
      '',
      truncate(patch, 50000),
    ].join('\n');
  } catch (e) {
    return `git diff failed: ${(e as Error).message}`;
  }
}

function parseDiffArgs(raw: string): { mode: 'unstaged' | 'staged' | 'all'; path?: string } {
  const arg = raw.trim();
  if (!arg) return { mode: 'unstaged' };
  if (arg === 'staged' || arg === '--staged') return { mode: 'staged' };
  if (arg === 'all' || arg === 'head' || arg === 'HEAD') return { mode: 'all' };
  return { mode: 'unstaged', path: arg };
}

async function runCodeCommand(raw: string): Promise<string> {
  const [verb = '', ...rest] = raw.split(/\s+/).filter(Boolean);
  const query = rest.join(' ');
  try {
    if (verb === 'diagnostics' || verb === 'diag') {
      if (rest[0]) {
        const result = await codeIntelTool.execute({ action: 'diagnostics', file: rest[0] });
        return result.output;
      }
      return (
        truncate(execSync('bun run typecheck', { encoding: 'utf8', timeout: 120000 }), 30000) ||
        'diagnostics passed'
      );
    }
    if (
      (verb === 'def' || verb === 'definition' || verb === 'refs' || verb === 'references') &&
      rest.length >= 3
    ) {
      const [file, lineRaw, characterRaw] = rest;
      const line = Number.parseInt(lineRaw ?? '', 10);
      const character = Number.parseInt(characterRaw ?? '', 10);
      if (file && Number.isFinite(line) && Number.isFinite(character)) {
        const result = await codeIntelTool.execute({
          action: verb === 'refs' || verb === 'references' ? 'references' : 'definition',
          file,
          line,
          character,
        });
        return result.output;
      }
    }
    if (verb === 'symbols' && rest.length === 1 && /\.(tsx?|jsx?)$/.test(rest[0] ?? '')) {
      const result = await codeIntelTool.execute({ action: 'symbols', file: rest[0] });
      return result.output;
    }
    if (!query && verb !== 'symbols') {
      return 'usage: /code [symbols|def|refs|diagnostics] [query]';
    }
    if (verb === 'symbols') {
      const pattern = query
        ? definitionPattern(query)
        : String.raw`^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+[A-Za-z0-9_$]+`;
      return rgCommand(pattern);
    }
    if (verb === 'def' || verb === 'definition') return rgCommand(definitionPattern(query));
    if (verb === 'refs' || verb === 'references') return rgCommand(escapeRegex(query));
    return 'usage: /code [symbols|def|refs|diagnostics] [query]';
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return truncate([error.stdout, error.stderr, error.message].filter(Boolean).join('\n'), 30000);
  }
}

function rgCommand(pattern: string): string {
  const cmd = `rg --line-number --no-heading --color=never --glob '!node_modules' --glob '!dist' ${quote(pattern)} .`;
  const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
  return truncate(out || '(no matches)', 30000);
}

function definitionPattern(query: string): string {
  const q = escapeRegex(query);
  return String.raw`^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+${q}\b`;
}

function reviewHints(diff: string): string[] {
  const addedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  const checks: Array<[RegExp, string]> = [
    [/\bTODO\b|\bFIXME\b/i, 'New TODO/FIXME markers were added.'],
    [/\bconsole\.log\b/, 'New console.log calls were added.'],
    [/\bany\b/, 'New TypeScript any usage appears in added lines.'],
    [/\beval\s*\(/, 'New eval usage appears in added lines.'],
    [/\bexecSync\s*\(|\bspawn\s*\(|\bexeca\s*\(/, 'New process execution code was added.'],
    [/\bprocess\.env\b/, 'New environment-variable reads were added.'],
    [
      /\bwriteFileSync\b|\bunlinkSync\b|\brmSync\b/,
      'New synchronous filesystem mutation code was added.',
    ],
  ];
  return checks
    .filter(([pattern]) => addedLines.some((line) => pattern.test(line)))
    .map(([, msg]) => msg);
}

function shellJoin(args: string[]): string {
  return args.map(quote).join(' ');
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

function hooksActionPicker(_ctx: CommandContext): ListSpec {
  return {
    kind: 'list',
    title: 'Hooks — pick an action',
    items: [
      { value: 'list', label: 'List', description: 'show configured hooks' },
      { value: 'add', label: 'Add', description: 'register a new hook' },
      { value: 'toggle', label: 'Toggle', description: 'enable / disable a hook' },
      { value: 'remove', label: 'Remove', description: 'delete a hook' },
    ],
    onPick: async (v): Promise<CommandResult> => {
      if (v === 'list') return formatHookList();
      if (v === 'add') return hooksAddForm();
      if (v === 'toggle') return hooksTogglePicker();
      if (v === 'remove') return hooksRemovePicker();
      return null;
    },
    onCancel: () => null,
  };
}

function formatSoulPaths(): string {
  const userRoot = process.env['ASTERISK_HOME'] ?? `${process.env['HOME'] ?? '~'}/.asterisk`;
  return [
    'SOUL.md candidates (in resolution order):',
    `  user   ${userRoot}/SOUL.md`,
    `  project ${process.cwd()}/.asterisk/SOUL.md`,
    `  project ${process.cwd()}/SOUL.md`,
    '',
    'User soul applies everywhere; project soul layers on top in repos.',
  ].join('\n');
}

async function soulInit(): Promise<string> {
  const userRoot = process.env['ASTERISK_HOME'] ?? `${process.env['HOME']}/.asterisk`;
  const path = `${userRoot}/SOUL.md`;
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  if (existsSync(path)) {
    return `SOUL.md already exists at ${path}. Edit it with your editor; /soul shows the loaded content.`;
  }
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(path, DEFAULT_SOUL_TEMPLATE, { mode: 0o644 });
  return `✓ wrote starter SOUL.md to ${path}\nEdit it with your editor — applies on the next turn.`;
}

function formatHookList(): string {
  const cfg = loadConfig().config;
  if (cfg.hooks.length === 0) {
    return [
      'No hooks configured.',
      '',
      'Hooks fire shell commands at agent-loop events:',
      '  before_turn / after_turn / before_tool / after_tool / on_error',
      '',
      'Add one with /hooks add — your command receives the event payload',
      'as JSON on stdin and can do whatever (lint, log, notify, …).',
    ].join('\n');
  }
  const lines = [`Hooks  ${cfg.hooks.length} configured`];
  for (const h of cfg.hooks) {
    const dot = h.enabled ? '●' : '○';
    const matcher = h.matcher ? `  /${h.matcher}/` : '';
    lines.push(`  ${dot} ${h.name.padEnd(24)} ${h.event.padEnd(12)}${matcher}`);
    lines.push(`    ${h.command}`);
  }
  return lines.join('\n');
}

function hooksAddForm(): FormSpec {
  return {
    kind: 'form',
    title: 'Add a hook',
    fields: [
      { kind: 'text', key: 'name', label: 'Name', placeholder: 'lint-on-write', required: true },
      {
        kind: 'select',
        key: 'event',
        label: 'Event',
        options: [
          {
            value: 'before_turn',
            label: 'before_turn',
            description: 'before the user message goes to the model',
          },
          { value: 'after_turn', label: 'after_turn', description: 'after the agent finishes' },
          { value: 'before_tool', label: 'before_tool', description: 'before each tool call' },
          { value: 'after_tool', label: 'after_tool', description: 'after each tool call' },
          { value: 'on_error', label: 'on_error', description: 'on agent or tool error' },
        ],
        defaultValue: 'after_tool',
      },
      {
        kind: 'text',
        key: 'matcher',
        label: 'Matcher (optional regex on tool/text)',
        placeholder: 'e.g. ^Write|Edit$',
      },
      {
        kind: 'text',
        key: 'command',
        label: 'Shell command',
        placeholder: 'jq -r .tool',
        required: true,
      },
      {
        kind: 'text',
        key: 'timeoutSeconds',
        label: 'Timeout (seconds)',
        defaultValue: '30',
      },
      { kind: 'confirm', key: 'enabled', label: 'Enable now?', defaultValue: 'yes' },
    ],
    onSubmit: (v) => {
      const cfg = loadConfig();
      const name = (v['name'] ?? '').trim();
      if (!name) return 'name is required';
      if (cfg.config.hooks.some((h: HookConfig) => h.name === name)) {
        return `hook "${name}" already exists`;
      }
      const timeoutN = Number.parseInt(v['timeoutSeconds'] ?? '30', 10);
      const matcher = (v['matcher'] ?? '').trim();
      const hook: HookConfig = {
        name,
        event: (v['event'] ?? 'after_tool') as HookConfig['event'],
        command: (v['command'] ?? '').trim(),
        timeoutSeconds: Number.isFinite(timeoutN) && timeoutN > 0 ? timeoutN : 30,
        enabled: (v['enabled'] ?? 'yes') === 'yes',
        ...(matcher ? { matcher } : {}),
      };
      cfg.config.hooks.push(hook);
      saveConfig(cfg.config);
      return `✓ added hook "${hook.name}" (${hook.event}${matcher ? ` / ${matcher}` : ''})`;
    },
    onCancel: () => '(cancelled)',
  };
}

function hooksRemovePicker(): ListSpec {
  const cfg = loadConfig().config;
  return {
    kind: 'list',
    title: 'Remove which hook?',
    items: cfg.hooks.map((h: HookConfig) => ({
      value: h.name,
      label: h.name,
      description: `${h.event} · ${h.command}`,
    })),
    emptyMessage: 'No hooks configured.',
    onPick: (name) => removeHookByName(name),
    onCancel: () => null,
  };
}

function removeHookByName(name: string): FormSpec {
  return {
    kind: 'form',
    title: `Remove hook "${name}"?`,
    fields: [{ kind: 'confirm', key: 'confirm', label: 'Are you sure?', defaultValue: 'no' }],
    onSubmit: (v) => {
      if (v['confirm'] !== 'yes') return '(kept)';
      const cfg = loadConfig();
      const before = cfg.config.hooks.length;
      cfg.config.hooks = cfg.config.hooks.filter((h: HookConfig) => h.name !== name);
      if (cfg.config.hooks.length === before) return `no hook named "${name}"`;
      saveConfig(cfg.config);
      return `✓ removed hook "${name}"`;
    },
    onCancel: () => '(cancelled)',
  };
}

function hooksTogglePicker(): ListSpec {
  const cfg = loadConfig().config;
  return {
    kind: 'list',
    title: 'Toggle which hook?',
    items: cfg.hooks.map((h: HookConfig) => ({
      value: h.name,
      label: h.name,
      description: `${h.event} · ${h.enabled ? 'enabled' : 'disabled'}`,
    })),
    emptyMessage: 'No hooks configured.',
    onPick: (name) => toggleHookByName(name),
    onCancel: () => null,
  };
}

function toggleHookByName(name: string): string {
  const cfg = loadConfig();
  const hook = cfg.config.hooks.find((h: HookConfig) => h.name === name);
  if (!hook) return `no hook named "${name}"`;
  hook.enabled = !hook.enabled;
  saveConfig(cfg.config);
  return `✓ "${name}" is now ${hook.enabled ? 'enabled' : 'disabled'}`;
}

// ─────────────────────────────────────────────────────────────────────────
//  Provider / model switching
// ─────────────────────────────────────────────────────────────────────────

/**
 * Switches the model on whichever backend is currently active, by handing the
 * factory a config with that one field overridden. The switch is in-memory —
 * `/config` persists it.
 */
function switchModel(ctx: CommandContext, model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return 'no model specified';
  const current = parseProviderName(ctx.provider.name);
  if (!current) return `cannot parse current provider: ${ctx.provider.name}`;

  const loaded = loadConfig();
  const kind = current.kind;
  if (kind === 'anthropic' && !loaded.secrets.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY not set; run `asterisk configure`';
  }

  loaded.config = {
    ...loaded.config,
    provider: kind,
    ...(kind === 'ollama' ? { ollama: { ...loaded.config.ollama, model: trimmed } } : {}),
    ...(kind === 'openai-compatible'
      ? { openaiCompatible: { ...loaded.config.openaiCompatible, model: trimmed } }
      : {}),
    ...(kind === 'anthropic' ? { anthropic: { ...loaded.config.anthropic, model: trimmed } } : {}),
  };

  ctx.setProvider(chooseProvider(loaded).provider);
  return `✓ switched to ${kind}:${trimmed}`;
}

function switchProvider(ctx: CommandContext, target: string): string {
  if (target !== 'ollama' && target !== 'openai-compatible' && target !== 'anthropic') {
    return `unknown provider: ${target} (expected ollama, openai-compatible, or anthropic)`;
  }

  const loaded = loadConfig();
  if (target === 'anthropic' && !loaded.secrets.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY not set; run `asterisk configure`';
  }

  loaded.config = { ...loaded.config, provider: target };
  const chosen = chooseProvider(loaded);
  ctx.setProvider(chosen.provider);
  return `✓ switched to ${chosen.provider.name}`;
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

// ─────────────────────────────────────────────────────────────────────────
//  /config sections
// ─────────────────────────────────────────────────────────────────────────

interface ConfigSection {
  key: string;
  label: string;
  summary: string;
  open(ctx: CommandContext): Promise<FormSpec | string> | FormSpec | string;
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
          {
            kind: 'text',
            key: 'baseUrl',
            label: 'Base URL',
            defaultValue: cfg.baseUrl,
            required: true,
          },
          {
            kind: 'text',
            key: 'model',
            label: 'Default model',
            defaultValue: cfg.model,
            required: true,
          },
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
    async open() {
      const cfg = loadConfig();
      const apiKey = cfg.secrets.ANTHROPIC_API_KEY ?? '';
      const models = await listAnthropicModels(apiKey);
      const defaultModel = models.some((m) => m.id === cfg.config.anthropic.model)
        ? cfg.config.anthropic.model
        : (models[0]?.id ?? cfg.config.anthropic.model);
      return {
        kind: 'form',
        title: apiKey
          ? `Anthropic settings (${models.length} models from /v1/models)`
          : 'Anthropic settings (offline list — set API key for live)',
        fields: [
          {
            kind: 'select',
            key: 'model',
            label: 'Default model',
            options: models.map((m) => {
              const opt: { value: string; label: string; description?: string } = {
                value: m.id,
                label: m.label,
              };
              if (m.label !== m.id) opt.description = m.id;
              return opt;
            }),
            defaultValue: defaultModel,
          },
          {
            kind: 'text',
            key: 'apiKey',
            label: 'API key (leave empty to keep existing)',
            placeholder: apiKey ? '(set)' : '(unset)',
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
    summary: 'enable, allowed user IDs, token, reply mode',
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
          {
            kind: 'select',
            key: 'streamMode',
            label: 'Reply delivery mode',
            options: [
              { value: 'final', label: 'final — one message at end (cheapest)' },
              { value: 'status', label: 'status — live tool-call status, replaced by final reply' },
              { value: 'stream', label: 'stream — text streams as it arrives' },
            ],
            defaultValue: cfg.config.bots.telegram.streamMode,
          },
          {
            kind: 'text',
            key: 'streamThrottleMs',
            label: 'Edit throttle (ms, 250–10000) · only used by status/stream',
            defaultValue: String(cfg.config.bots.telegram.streamThrottleMs),
          },
          {
            kind: 'select',
            key: 'parseMode',
            label: 'Text formatting',
            options: [
              {
                value: 'html',
                label: 'html — render **bold**, *italic*, `code`, links (recommended)',
              },
              { value: 'plain', label: 'plain — show markdown markers as literal text' },
            ],
            defaultValue: cfg.config.bots.telegram.parseMode,
          },
        ],
        onSubmit: (v) => {
          const next = loadConfig();
          next.config.bots.telegram.enabled = (v['enabled'] ?? 'no') === 'yes';
          next.config.bots.telegram.allowedUserIds = (v['allowedUserIds'] ?? '')
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 0);
          const rawMode = (v['streamMode'] ?? 'final').trim().toLowerCase();
          next.config.bots.telegram.streamMode =
            rawMode === 'status' || rawMode === 'stream' ? rawMode : 'final';
          const throttle = Number.parseInt(v['streamThrottleMs'] ?? '', 10);
          if (Number.isFinite(throttle) && throttle >= 250 && throttle <= 10000) {
            next.config.bots.telegram.streamThrottleMs = throttle;
          }
          const rawParse = (v['parseMode'] ?? 'html').trim().toLowerCase();
          next.config.bots.telegram.parseMode = rawParse === 'plain' ? 'plain' : 'html';
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

async function openConfigSection(
  ctx: CommandContext,
  section: ConfigSection,
): Promise<CommandResult> {
  return await section.open(ctx);
}

export function lookupCommand(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = space === -1 ? input : input.slice(0, space);
  const args = space === -1 ? '' : input.slice(space + 1);
  const command = COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}
