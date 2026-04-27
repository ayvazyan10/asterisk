// Slash-command registry. Commands return a string to render in the transcript;
// returning null tells the REPL to suppress output (e.g. /clear).

import type { AgentState } from '../agent/loop.ts';

export interface CommandContext {
  state: AgentState;
  providerName: string;
  exit: () => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  execute(ctx: CommandContext, args: string): string | null;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: '/help',
    description: 'List available commands.',
    execute() {
      return COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.description}`).join('\n');
    },
  },
  {
    name: '/clear',
    description: 'Clear the conversation history.',
    execute(ctx) {
      ctx.state.history = [];
      return 'history cleared';
    },
  },
  {
    name: '/model',
    description: 'Show the active provider/model.',
    execute(ctx) {
      return `provider: ${ctx.providerName}`;
    },
  },
  {
    name: '/config',
    description: 'Show config file path.',
    execute() {
      return `~/.asterisk/config.json (run \`asterisk configure\` to edit)`;
    },
  },
  {
    name: '/quit',
    description: 'Exit the REPL.',
    execute(ctx) {
      ctx.exit();
      return null;
    },
  },
];

export function lookupCommand(input: string): { command: SlashCommand; args: string } | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = space === -1 ? input : input.slice(0, space);
  const args = space === -1 ? '' : input.slice(space + 1);
  const command = COMMANDS.find((c) => c.name === name);
  return command ? { command, args } : null;
}
