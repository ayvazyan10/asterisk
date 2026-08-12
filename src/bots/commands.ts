// Bot-level slash commands — handled before the agent loop so they're cheap,
// predictable, and don't burn LLM tokens on housekeeping. Mirrors what the
// REPL's slash menu offers, but trimmed to the things that actually make
// sense over chat: meta + state inspection + reset.
//
// Telegram registers these via setMyCommands() so users see autocomplete.
// WhatsApp has no equivalent autocomplete UI but parses the same prefixes.

import { currentSession, currentSessionId } from '../agent/context.ts';
import type { AgentState } from '../agent/loop.ts';
import { renderCostCompact } from '../commands/usage-report.ts';
import { loadConfig, saveConfig } from '../config/load.ts';
import { OUTPUT_STYLES, findOutputStyle } from '../output-styles/styles.ts';
import { clearSessionSoul, loadSouls, readSessionSoul, writeSessionSoul } from '../soul/loader.ts';
import { isPlanMode, setPlanMode } from '../tools/planmode.ts';
import { _allTasks, clearTasksForCurrentSession } from '../tools/tasks.ts';
import { activeWorktree } from '../tools/worktree.ts';
import type { OutgoingMessage } from './adapter.ts';

export interface BotCommandSpec {
  command: string;
  description: string;
}

/** What we register with Telegram so users see autocomplete. */
export const BOT_COMMAND_LIST: BotCommandSpec[] = [
  { command: 'start', description: 'How to use this bot' },
  { command: 'help', description: 'Show the command list' },
  { command: 'status', description: 'Provider, model, your tasks + plan mode + worktree' },
  { command: 'clear', description: 'Forget our conversation history' },
  { command: 'reset', description: 'Clear history + tasks + plan mode + worktree' },
  { command: 'tasks', description: 'List your tasks' },
  { command: 'plan', description: 'Toggle plan mode (read-only research mode)' },
  { command: 'soul', description: 'Show / set / clear your personal persona' },
  {
    command: 'style',
    description: 'Switch reply style (default / concise / explanatory / learning)',
  },
  { command: 'cost', description: 'Token spend for this chat, today, and lifetime' },
];

const HELP_TEXT = `👋 I'm Asterisk, a personal AI assistant. Just message me anything — I can read files, run shell commands, browse the web, take screenshots, schedule tasks, and more.

Commands:
/help    — show this message
/status  — provider + model + your session info
/clear   — forget our conversation
/reset   — clear everything (history, tasks, plan mode)
/tasks   — list your tasks
/plan    — toggle Plan Mode (read-only research mode)
/soul    — show / set / clear your personal persona (try /soul help)
/cost    — token spend for this chat, today, and lifetime

Otherwise just type what you want me to do.`;

interface CommandContext {
  state: AgentState;
  providerName: string;
}

/** Try to handle a message as a bot command. Returns an OutgoingMessage if
 *  the command was recognised; null if the message should fall through to
 *  the agent. Must be called inside the chat's session ALS scope so it can
 *  read per-session state. */
export function tryHandleBotCommand(text: string, ctx: CommandContext): OutgoingMessage | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  // Slice off the leading `/`, then split into "command word" and "rest".
  // Rest preserves newlines and internal whitespace so /soul set <multi-line
  // markdown> reaches us intact.
  const body = trimmed.slice(1);
  const firstWs = body.search(/\s/);
  let head = firstWs === -1 ? body : body.slice(0, firstWs);
  const rest = firstWs === -1 ? '' : body.slice(firstWs + 1);
  // Telegram appends "@botname" to commands in group chats — strip it.
  const at = head.indexOf('@');
  if (at !== -1) head = head.slice(0, at);
  const cmd = head.toLowerCase();

  switch (cmd) {
    case 'start':
    case 'help':
      return { text: HELP_TEXT };

    case 'status':
      return { text: renderStatus(ctx) };

    case 'cost': {
      // Scoped to the calling chat via the ambient session, so one user can't
      // read another's spend.
      const session = currentSession();
      return { text: renderCostCompact(session.scope, session.id) };
    }

    case 'clear':
      ctx.state.history.length = 0;
      return { text: '✓ conversation cleared.' };

    case 'reset':
      ctx.state.history.length = 0;
      clearTasksForCurrentSession();
      setPlanMode(false);
      return {
        text: '✓ reset · history cleared, tasks dropped, plan mode off, worktree (if any) untouched.',
      };

    case 'tasks':
      return { text: renderTasks() };

    case 'plan':
      setPlanMode(!isPlanMode());
      return {
        text: isPlanMode()
          ? '✓ Plan Mode ON · I can only research; no writes until /plan again.'
          : '✓ Plan Mode OFF · all tools re-enabled.',
      };

    case 'soul':
      return { text: handleSoulCommand(rest) };

    case 'style':
    case 'output-style':
    case 'output_style':
      return { text: handleStyleCommand(rest) };

    default:
      // Unknown slash command — fall through. The agent might still want to
      // do something with it (e.g. user types "/etc/hosts" thinking of a path).
      return null;
  }
}

function renderStatus(ctx: CommandContext): string {
  const cfg = loadConfig().config;
  const sid = currentSessionId();
  const tasks = _allTasks();
  const tasksByStatus = {
    pending: tasks.filter((t) => t.status === 'pending').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    cancelled: tasks.filter((t) => t.status === 'cancelled').length,
  };
  const wt = activeWorktree();
  const lines = [
    `Session   ${sid}`,
    `Provider  ${ctx.providerName}`,
    `Model     ${cfg.provider === 'anthropic' ? cfg.anthropic.model : cfg.ollama.model}`,
    `History   ${ctx.state.history.length} message${ctx.state.history.length === 1 ? '' : 's'}`,
    `Tasks     ${tasks.length} total · ${tasksByStatus.in_progress} in_progress · ${tasksByStatus.completed} done · ${tasksByStatus.pending} pending`,
    `Plan Mode ${isPlanMode() ? 'ON (read-only)' : 'off'}`,
    `Worktree  ${wt ? `${wt.path} (branch ${wt.branch})` : '(none)'}`,
  ];
  return lines.join('\n');
}

function renderTasks(): string {
  const tasks = _allTasks();
  if (tasks.length === 0) return '(no tasks yet — I create them as I work on multi-step things)';
  const icon = (s: string): string =>
    s === 'completed' ? '✓' : s === 'in_progress' ? '◐' : s === 'cancelled' ? '✗' : '○';
  const lines = ['Your tasks:'];
  for (const t of tasks) {
    lines.push(
      `${icon(t.status)} #${t.id}  ${t.title}${t.description ? ` — ${t.description}` : ''}`,
    );
  }
  return lines.join('\n');
}

const SOUL_HELP = [
  'Soul commands:',
  '/soul                — show what I currently load for you',
  '/soul set <text>     — replace your personal soul with <text>',
  '                       (multi-line markdown is fine — send it all in one message)',
  '/soul edit           — print your current soul so you can copy + tweak it',
  '/soul clear          — drop your personal soul (operator/project soul still apply)',
  '/soul help           — this message',
  '',
  'Layers (later wins): operator → your soul → project soul.',
].join('\n');

function handleSoulCommand(rest: string): string {
  const session = currentSession();
  const trimmed = rest.trim();
  const verbMatch = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const verb = verbMatch?.[1]?.toLowerCase() ?? '';
  const body = verbMatch?.[2]?.trim() ?? '';

  if (verb === 'help' || verb === '?') return SOUL_HELP;

  if (verb === 'set') {
    if (!body) {
      return 'Usage: /soul set <text>\nSend the persona description after `set` in the same message. Try `/soul help`.';
    }
    const path = writeSessionSoul(session, body);
    return [
      `✓ saved your soul (${body.length} chars).`,
      `Stored at ${path}.`,
      'It applies on the next turn. /soul clear to remove it.',
    ].join('\n');
  }

  if (verb === 'clear' || verb === 'reset' || verb === 'forget') {
    const removed = clearSessionSoul(session);
    return removed
      ? '✓ your personal soul has been removed.'
      : '(no personal soul set — nothing to clear.)';
  }

  if (verb === 'edit' || verb === 'export') {
    const raw = readSessionSoul(session);
    if (!raw) {
      return [
        'You have no personal soul yet. Send something like:',
        '',
        '/soul set Call me Levon. Reply in Russian. Skip apologies. Be terse.',
      ].join('\n');
    }
    return [
      'Your current soul (copy, tweak, send back as `/soul set <new>`):',
      '',
      raw.trim(),
    ].join('\n');
  }

  // No verb (or anything we don't recognise as an action) → show what's loaded.
  if (verb === '' || verb === 'show') return renderSoulDisplay(session);
  return `Unknown subcommand "${verb}". /soul help for the list.`;
}

function handleStyleCommand(rest: string): string {
  const requested = rest.trim().toLowerCase();
  if (!requested) {
    const cur = loadConfig().config.outputStyle;
    const lines = [`Current output style: ${cur}`, '', 'Options:'];
    for (const s of OUTPUT_STYLES) {
      const marker = s.name === cur ? '●' : '○';
      lines.push(`  ${marker} ${s.name.padEnd(11)} ${s.description}`);
    }
    lines.push('', 'Switch with: /style <name>');
    return lines.join('\n');
  }
  const next = findOutputStyle(requested);
  if (!next) {
    const valid = OUTPUT_STYLES.map((s) => s.name).join(' · ');
    return `unknown style "${requested}". Valid: ${valid}`;
  }
  const cfg = loadConfig().config;
  cfg.outputStyle = next.name;
  saveConfig(cfg);
  return `✓ output style set to "${next.name}" — ${next.description}`;
}

function renderSoulDisplay(session: ReturnType<typeof currentSession>): string {
  const souls = loadSouls(process.cwd(), session);
  if (souls.length === 0) {
    return [
      'No soul loaded yet — I have only my default behaviour.',
      '',
      'Give me a persona with:',
      '/soul set <how you want me to behave; who you are>',
    ].join('\n');
  }
  const lines: string[] = ['Soul currently in effect:', ''];
  for (const s of souls) {
    const tag =
      s.scope === 'session' ? 'your soul' : s.scope === 'user' ? 'operator soul' : 'project soul';
    lines.push(`# ${tag} · ${s.path}`);
    const body = s.content.length > 1500 ? `${s.content.slice(0, 1500)}\n…(truncated)` : s.content;
    lines.push(body);
    lines.push('');
  }
  return lines.join('\n').trim();
}
