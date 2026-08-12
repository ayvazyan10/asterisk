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
import { type Skill, loadSkills, loadSkillsWithIssues } from '../skills/loader.ts';
import { formatSkillReport, skillIssueSummary } from '../skills/report.ts';
import { DEFAULT_SOUL_TEMPLATE, type Soul, loadSouls } from '../soul/loader.ts';
import { codeIntelTool } from '../tools/code-intel.ts';
import { isPlanMode, setPlanMode } from '../tools/planmode.ts';
import { listTools, setExtraTools } from '../tools/registry.ts';
import { _allTasks } from '../tools/tasks.ts';
import type { Provider } from '../types/messages.ts';
import { getVersion } from '../version.ts';
import { codeCommand, diffCommand, reviewCommand } from './code-flows.ts';
import { configCommand } from './config-flows.ts';
import { doctorCommand } from './doctor.ts';
import { hooksCommand } from './hooks-flows.ts';
import { mcpCommand } from './mcp.ts';
import { type ProviderKind, parseProviderName } from './models.ts';
import {
  ANTHROPIC_FALLBACK_MODELS,
  type AnthropicModel,
  listAnthropicModels,
  listOllamaModels,
  listOpenAiCompatibleModels,
} from './models.ts';
import { permissionsCommand } from './permissions.ts';
import { pluginsCommand } from './plugins.ts';
import { forgetCommand, resumeCommand, sessionsCommand } from './session-flows.ts';
import { escapeRegex, quote, shellJoin, truncate } from './text.ts';

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

      if (current?.kind === 'openai-compatible') {
        // Ask the endpoint what it serves. Falling through to the Anthropic
        // list here used to write a Claude id into openaiCompatible.model,
        // because switchModel keys off the *current* provider kind.
        const cfg = loadConfig().config.openaiCompatible;
        const models = await listOpenAiCompatibleModels(cfg.baseUrl);
        if (models.length === 0) {
          return `(could not reach ${cfg.baseUrl}/models — pass a model name: /model <id>)`;
        }
        const list: ListSpec = {
          kind: 'list',
          title: 'Pick a model',
          items: models.map((m) => ({
            value: m,
            label: m,
            ...(m === current.model ? { badge: '* current' } : {}),
          })),
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
      const tgState = tg.enabled
        ? `enabled · ${tg.allowedUserIds.length} allowlisted ${secrets.ASTERISK_TELEGRAM_BOT_TOKEN ? '· token set' : '· ⚠ NO TOKEN'}`
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
        `MCP        ${mcpLine}`,
        `Daemon     ${daemonLine}`,
        '',
        `Config     ${configLine}`,
        `Secrets    ${secretsLine}`,
        `Home       ${paths.root}`,
      ].join('\n');
    },
  },
  configCommand,
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
  mcpCommand,
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
    description: 'List installed skills, or check them with /skills validate',
    usage: '/skills [validate]',
    execute(_ctx, args) {
      const verb = args.trim().toLowerCase();
      if (verb && verb !== 'validate' && verb !== 'list') {
        return `unknown argument: ${verb} — usage: /skills [validate]`;
      }
      const load = loadSkillsWithIssues();
      if (verb === 'validate') return formatSkillReport(load);

      const { skills, issues } = load;
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
      // Broken skills are invisible in the listing above — they never loaded —
      // so the count has to be said out loud or it is lost.
      const summary = skillIssueSummary(issues);
      if (summary) lines.push(summary);
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
  hooksCommand,
  permissionsCommand,
  pluginsCommand,
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
  sessionsCommand,
  resumeCommand,
  forgetCommand,
  diffCommand,
  reviewCommand,
  codeCommand,
  doctorCommand,
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

export function lookupCommand(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = space === -1 ? input : input.slice(0, space);
  const args = space === -1 ? '' : input.slice(space + 1);
  const command = COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}
