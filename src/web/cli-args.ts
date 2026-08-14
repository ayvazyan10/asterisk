// Argument parsing for `asterisk web`.
//
// Lives outside the entrypoint so it can be unit-tested: importing
// entrypoints/web.ts runs main().

export type WebCommand = 'start' | 'stop';

export interface WebFlags {
  port?: number;
  host?: string;
  auth: boolean;
  open: boolean;
  printToken: boolean;
  /** Run the server in this process instead of spawning a background one. */
  foreground: boolean;
}

export interface WebArgs {
  command: WebCommand;
  flags: WebFlags;
}

const COMMANDS = new Set<WebCommand>(['start', 'stop']);

function isCommand(value: string): value is WebCommand {
  return COMMANDS.has(value as WebCommand);
}

export function parseWebArgs(argv: readonly string[]): WebArgs {
  const flags: WebFlags = {
    auth: true,
    open: true,
    printToken: false,
    foreground: false,
  };
  let command: WebCommand = 'start';
  let sawCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--port': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error('--port expects an integer between 1 and 65535');
        }
        flags.port = value;
        break;
      }
      case '--host': {
        const value = argv[++i];
        if (!value) throw new Error('--host expects an address');
        flags.host = value;
        break;
      }
      case '--no-auth':
        flags.auth = false;
        break;
      case '--no-open':
        flags.open = false;
        break;
      case '--print-token':
        flags.printToken = true;
        break;
      case '--foreground':
        flags.foreground = true;
        break;
      default: {
        if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
        if (sawCommand) throw new Error(`unexpected argument: ${arg}`);
        if (!isCommand(arg)) {
          throw new Error(`unknown subcommand: ${arg} (expected 'start' or 'stop')`);
        }
        command = arg;
        sawCommand = true;
      }
    }
  }

  return { command, flags };
}

/** Rebuilds the flags the background child needs, minus the ones only the parent acts on. */
export function childArgv(flags: WebFlags): string[] {
  const argv = ['--foreground', '--no-open'];
  if (flags.host !== undefined) argv.push('--host', flags.host);
  if (flags.port !== undefined) argv.push('--port', String(flags.port));
  if (!flags.auth) argv.push('--no-auth');
  return argv;
}
