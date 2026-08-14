// `asterisk web` — the settings control panel.
//
// Starting it puts the server in the *background* and returns the terminal:
// the URL (with a token, on a fresh install) is printed and the process
// detaches. `asterisk web stop` terminates it and frees the port. The
// foreground server lives in a child of this same entrypoint, re-invoked with
// `--foreground`; that flag is also the supported way to run the panel under
// systemd or in a container, where a detaching process is the wrong shape.
//
// Usage:
//   asterisk web [flags]     start in the background, print the URL
//   asterisk web stop        stop it and free the port
//
// Flags:
//   --port <n>       override the configured port
//   --host <addr>    override the configured bind address
//   --no-auth        disable token auth (loopback binds only)
//   --no-open        do not launch a browser
//   --foreground     run the server in this process (Ctrl+C to stop)
//   --print-token    issue a fresh token, print it, and exit

import { spawn } from 'node:child_process';

import { loadConfig } from '../config/load.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { type SqliteDriver, getDb } from '../db/index.ts';
import { getVersion } from '../version.ts';
import { hasAnyToken, issueToken } from '../web/auth.ts';
import { type WebFlags, parseWebArgs } from '../web/cli-args.ts';
import { startWebPanel, stopWebPanel } from '../web/lifecycle.ts';
import { clearWebState, writeWebState } from '../web/runtime-state.ts';
import { startWebServer } from '../web/server.ts';

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

interface Binding {
  host: string;
  port: number;
  authRequired: boolean;
}

interface Resolved {
  binding: Binding;
  /** Config preference; the `--no-open` flag can still veto it. */
  openBrowser: boolean;
}

/**
 * Settles where the panel will listen and whether it will ask for a token.
 *
 * Both the background parent and the foreground child run this: the parent so
 * a refusal reaches the terminal instead of the log, the child because it is
 * also a supported way to start the panel on its own.
 */
function resolveBinding(flags: WebFlags): Resolved {
  const { config } = loadConfig();
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

  return { binding: { host, port, authRequired }, openBrowser: config.web.openBrowser };
}

/** Prints the panel's address plus everything worth knowing about how it is exposed. */
function reportServing(url: string, binding: Binding, token: string | undefined): void {
  console.log(`Asterisk control panel v${getVersion()}`);
  console.log(`  ${url}`);
  console.log(`  database  ${asteriskPaths().dbFile}`);
  if (!binding.authRequired) {
    console.log('  auth      DISABLED — anyone who can reach this port has full control');
  } else if (!token) {
    console.log('  auth      token required — run `asterisk web --print-token` for a new one');
  }
  if (!isLoopback(binding.host)) {
    console.log(`  warning   bound to ${binding.host}, not loopback. Put TLS in front of it.`);
  }
}

/** Binds the port in this process and stays until signalled. */
function runForeground(flags: WebFlags, resolved: Resolved, db: SqliteDriver): void {
  const { binding } = resolved;
  // A fresh install has no token; mint one so the printed link just works.
  // In the background case the parent has already done this, so `hasAnyToken`
  // is true here and the plaintext exists in exactly one place — the parent's
  // output.
  let token: string | undefined;
  if (binding.authRequired && !hasAnyToken(db)) token = issueToken(db, 'first-run');

  let server: ReturnType<typeof startWebServer>;
  try {
    server = startWebServer({ db, ...binding });
  } catch (e) {
    console.error(
      `asterisk web: could not bind ${binding.host}:${binding.port} — ${(e as Error).message}`,
    );
    process.exit(1);
  }

  // Written only once the bind has succeeded: the parent waits on this file to
  // decide whether the start worked.
  writeWebState({
    pid: process.pid,
    url: server.url,
    host: binding.host,
    port: binding.port,
    authRequired: binding.authRequired,
    startedAt: Date.now(),
  });

  const url = token ? `${server.url}/?token=${token}` : server.url;
  reportServing(url, binding, token);

  if (flags.open && resolved.openBrowser) openBrowser(url);

  const shutdown = (): void => {
    // Order matters: drop the record first, so nothing can read an address
    // that is already closing.
    clearWebState();
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Spawns the server as a detached child and reports where it landed. */
async function runBackground(flags: WebFlags, resolved: Resolved, db: SqliteDriver): Promise<void> {
  const { binding } = resolved;
  let token: string | undefined;
  if (binding.authRequired && !hasAnyToken(db)) token = issueToken(db, 'first-run');

  const result = await startWebPanel(flags);
  if (!result.ok || !result.url) {
    console.error(`asterisk web: ${result.message}`);
    process.exit(1);
  }

  const url = token ? `${result.url}/?token=${token}` : result.url;
  reportServing(url, binding, token);
  console.log(`  log       ${asteriskPaths().webLog}`);
  console.log('  stop      asterisk web stop');

  if (flags.open && resolved.openBrowser) openBrowser(url);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseWebArgs>;
  try {
    parsed = parseWebArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`asterisk web: ${(e as Error).message}`);
    process.exit(2);
  }
  const { command, flags } = parsed;

  // Stopping touches neither the config nor the database.
  if (command === 'stop') {
    const result = await stopWebPanel();
    console.log(result.message);
    process.exit(result.ok ? 0 : 1);
  }

  // Loading the config also runs the one-time import from config.json.
  const db = getDb();

  if (flags.printToken) {
    console.log(issueToken(db, 'cli'));
    return;
  }

  const resolved = resolveBinding(flags);
  if (flags.foreground) runForeground(flags, resolved, db);
  else await runBackground(flags, resolved, db);
}

main().catch((e: unknown) => {
  console.error(`asterisk web: ${(e as Error).message}`);
  process.exit(1);
});
