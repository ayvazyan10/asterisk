// Control entrypoint — invoked by bin/asterisk for daemon subcommands.
// Reads argv[2..], dispatches to lifecycle.ts, prints the result, exits.

import { logs, restart, start, status, stop } from '../daemon/lifecycle.ts';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  let result: { ok: boolean; message: string };

  switch (cmd) {
    case 'start':
      result = await start();
      break;
    case 'stop':
      result = await stop();
      break;
    case 'restart':
      result = await restart();
      break;
    case 'status':
      result = status();
      break;
    case 'logs': {
      const n = Number(process.argv[3] ?? 50);
      result = logs(Number.isFinite(n) ? n : 50);
      break;
    }
    default:
      result = { ok: false, message: `unknown control command: ${cmd}` };
  }

  process.stdout.write(`${result.message}\n`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`asterisk control error: ${(e as Error).message}\n`);
  process.exit(1);
});
