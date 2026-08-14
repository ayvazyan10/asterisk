import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asteriskPaths } from '../src/daemon/paths.ts';
import { statusFromPidFile } from '../src/daemon/pidfile.ts';
import { type WebFlags, childArgv, parseWebArgs } from '../src/web/cli-args.ts';
import { startWebPanel, stopWebPanel } from '../src/web/lifecycle.ts';
import { clearWebState, readWebState } from '../src/web/runtime-state.ts';

describe('parseWebArgs', () => {
  it('defaults to starting in the background', () => {
    const { command, flags } = parseWebArgs([]);
    expect(command).toBe('start');
    expect(flags.foreground).toBe(false);
    expect(flags.auth).toBe(true);
    expect(flags.open).toBe(true);
  });

  it('recognises the stop subcommand and the foreground flag', () => {
    expect(parseWebArgs(['stop']).command).toBe('stop');
    expect(parseWebArgs(['--foreground']).flags.foreground).toBe(true);
    expect(parseWebArgs(['start', '--port', '8080']).flags.port).toBe(8080);
  });

  it('rejects out-of-range ports, unknown flags and unknown subcommands', () => {
    expect(() => parseWebArgs(['--port', '0'])).toThrow(/between 1 and 65535/);
    expect(() => parseWebArgs(['--port', '70000'])).toThrow(/between 1 and 65535/);
    expect(() => parseWebArgs(['--host'])).toThrow(/expects an address/);
    expect(() => parseWebArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseWebArgs(['status'])).toThrow(/unknown subcommand/);
    expect(() => parseWebArgs(['stop', 'start'])).toThrow(/unexpected argument/);
  });

  it('carries the remaining flags through', () => {
    const { flags } = parseWebArgs(['--no-open', '--no-auth', '--print-token', '--host', '::1']);
    expect(flags.open).toBe(false);
    expect(flags.auth).toBe(false);
    expect(flags.printToken).toBe(true);
    expect(flags.host).toBe('::1');
  });

  it('sends nothing but the essentials when no binding is overridden', () => {
    const argv = childArgv({ auth: true, open: false, printToken: false, foreground: false });
    expect(argv).toEqual(['--foreground', '--no-open']);
  });

  it('passes the binding to the child but never the browser or token flags', () => {
    const argv = childArgv({
      host: '127.0.0.1',
      port: 4444,
      auth: false,
      open: true,
      printToken: true,
      foreground: false,
    });
    expect(argv).toContain('--foreground');
    // The parent owns the browser and the token; the child must not repeat either.
    expect(argv).toContain('--no-open');
    expect(argv).not.toContain('--print-token');
    expect(argv.join(' ')).toContain('--host 127.0.0.1');
    expect(argv.join(' ')).toContain('--port 4444');
    expect(argv).toContain('--no-auth');
  });
});

/** A port the OS just confirmed is free, so the test never fights a real service. */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not probe a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

function flagsFor(port: number): WebFlags {
  return { host: '127.0.0.1', port, auth: true, open: false, printToken: false, foreground: false };
}

describe('control panel lifecycle', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevSource: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-web-'));
    prevHome = process.env['ASTERISK_HOME'];
    prevSource = process.env['ASTERISK_ENTRY_FROM_SOURCE'];
    process.env['ASTERISK_HOME'] = home;
    // `bun run test` runs before `bun run build`, so a stale dist/ must not be
    // what the spawned child executes.
    process.env['ASTERISK_ENTRY_FROM_SOURCE'] = '1';
  });

  afterEach(async () => {
    await stopWebPanel().catch(() => {});
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    if (prevSource === undefined) delete process.env['ASTERISK_ENTRY_FROM_SOURCE'];
    else process.env['ASTERISK_ENTRY_FROM_SOURCE'] = prevSource;
    await rm(home, { recursive: true, force: true });
  });

  it('starts detached, serves, and frees the port on stop', async () => {
    const port = await freePort();
    const started = await startWebPanel(flagsFor(port));
    expect(started.ok, started.message).toBe(true);
    expect(started.url).toBe(`http://127.0.0.1:${port}`);

    const paths = asteriskPaths();
    expect(statusFromPidFile(paths.webPidFile).running).toBe(true);
    const state = readWebState();
    expect(state?.port).toBe(port);
    expect(state?.url).toBe(`http://127.0.0.1:${port}`);

    // The panel is really listening; without a token it answers 401 rather
    // than refusing the connection.
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(401);

    const stopped = await stopWebPanel();
    expect(stopped.ok, stopped.message).toBe(true);
    expect(stopped.message).toContain(`port ${port}`);
    expect(statusFromPidFile(paths.webPidFile).running).toBe(false);
    expect(existsSync(paths.webStateFile)).toBe(false);

    // The point of the whole exercise: the same port binds again, which it
    // could not do if the listening socket had outlived the stop.
    const again = await startWebPanel(flagsFor(port));
    expect(again.ok, again.message).toBe(true);
    expect((await stopWebPanel()).ok).toBe(true);
  }, 60_000);

  it('refuses to start a second panel over a running one', async () => {
    const port = await freePort();
    expect((await startWebPanel(flagsFor(port))).ok).toBe(true);

    const second = await startWebPanel(flagsFor(await freePort()));
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already running \(pid \d+\)/);
    // The running panel is named, not the one that was asked for.
    expect(second.message).toContain(`:${port}`);
  }, 60_000);

  it('stopping when nothing runs is a no-op, not an error', async () => {
    const result = await stopWebPanel();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('control panel not running');
  });

  it('treats an unreadable address record as absent', async () => {
    const { webStateFile } = asteriskPaths();
    await writeFile(webStateFile, 'not json at all');
    expect(readWebState()).toBeNull();

    await writeFile(webStateFile, JSON.stringify({ pid: 1, host: '127.0.0.1' }));
    expect(readWebState()).toBeNull();

    clearWebState();
    expect(existsSync(webStateFile)).toBe(false);
    // Clearing a record that is already gone is not an error.
    expect(() => clearWebState()).not.toThrow();
  });
});
