// `asterisk web` — starts the settings control panel.
//
// Flags:
//   --port <n>       override the configured port
//   --host <addr>    override the configured bind address
//   --no-auth        disable token auth (loopback binds only)
//   --no-open        do not launch a browser
//   --print-token    issue a fresh token, print it, and exit

import { spawn } from 'node:child_process';

import { loadConfig } from '../config/load.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { getDb } from '../db/index.ts';
import { getVersion } from '../version.ts';
import { hasAnyToken, issueToken } from '../web/auth.ts';
import { startWebServer } from '../web/server.ts';

interface Flags {
  port?: number;
  host?: string;
  auth: boolean;
  open: boolean;
  printToken: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { auth: true, open: true, printToken: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }

  return flags;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless boxes have no opener; the URL is printed anyway.
  }
}

/** Non-loopback binds are a real exposure, so they are called out loudly. */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

async function main(): Promise<void> {
  let flags: Flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (e) {
    console.error(`asterisk web: ${(e as Error).message}`);
    process.exit(2);
  }

  // Loading the config also runs the one-time import from config.json.
  const { config } = loadConfig();
  const db = getDb();

  if (flags.printToken) {
    console.log(issueToken(db, 'cli'));
    return;
  }

  const host = flags.host ?? config.web.host;
  const port = flags.port ?? config.web.port;
  const authRequired = flags.auth && config.web.authRequired;

  if (!authRequired && !isLoopback(host)) {
    console.error(
      `asterisk web: refusing to serve without authentication on ${host}.\n  --no-auth is only allowed on a loopback address.`,
    );
    process.exit(2);
  }

  // Loopback is not a boundary against a browser: a page the user visits can
  // reach 127.0.0.1, and the panel writes hook commands that later run through
  // bash. Host and Origin validation blocks the drive-by case, but running with
  // no credential at all still means any local process — or any local user —
  // has full control, so it takes a deliberate opt-in.
  if (!authRequired && process.env['ASTERISK_I_UNDERSTAND_NO_AUTH'] !== '1') {
    console.error(
      'asterisk web: --no-auth disables the only credential on a panel that can\n' +
        '  write shell commands executed by the agent. Set\n' +
        '  ASTERISK_I_UNDERSTAND_NO_AUTH=1 to proceed, or drop the flag and use\n' +
        '  `asterisk web --print-token`.',
    );
    process.exit(2);
  }

  // A fresh install has no token; mint one so the printed link just works.
  let token: string | undefined;
  if (authRequired && !hasAnyToken(db)) token = issueToken(db, 'first-run');

  let server: ReturnType<typeof startWebServer>;
  try {
    server = startWebServer({ db, host, port, authRequired });
  } catch (e) {
    console.error(`asterisk web: could not bind ${host}:${port} — ${(e as Error).message}`);
    process.exit(1);
  }

  const url = token ? `${server.url}/?token=${token}` : server.url;

  console.log(`Asterisk control panel v${getVersion()}`);
  console.log(`  ${url}`);
  console.log(`  database  ${asteriskPaths().dbFile}`);
  if (!authRequired) {
    console.log('  auth      DISABLED — anyone who can reach this port has full control');
  } else if (!token) {
    console.log('  auth      token required — run `asterisk web --print-token` for a new one');
  }
  if (!isLoopback(host)) {
    console.log(`  warning   bound to ${host}, not loopback. Put TLS in front of it.`);
  }

  if (flags.open && config.web.openBrowser) openBrowser(url);

  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(`asterisk web: ${(e as Error).message}`);
  process.exit(1);
});
