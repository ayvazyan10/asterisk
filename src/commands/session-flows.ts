// `/sessions`, `/resume` and `/forget` — saved conversation management.
//
// Split out of registry.ts to keep it under the repo's 800-line limit.
// Pure move — no behaviour changed.

import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from '../agent/persistence.ts';
import type { ListSpec } from '../repl/forms/types.ts';
import type { CommandContext, SlashCommand } from './registry.ts';

export const sessionsCommand: SlashCommand = {
  name: '/sessions',
  description: 'List saved conversations',
  execute() {
    return formatSessions();
  },
};

export const resumeCommand: SlashCommand = {
  name: '/resume',
  description: 'Resume a saved conversation',
  usage: '/resume [id]',
  execute(ctx, args) {
    const id = args.trim();
    if (!id) return resumePicker(ctx);
    return resumeConversation(ctx, id);
  },
};

export const forgetCommand: SlashCommand = {
  name: '/forget',
  description: 'Delete a saved conversation',
  usage: '/forget [id]',
  execute(_ctx, args) {
    const id = args.trim();
    if (!id) return forgetPicker();
    return forgetConversation(id);
  },
};

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
