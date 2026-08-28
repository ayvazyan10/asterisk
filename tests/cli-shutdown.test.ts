// Regression coverage for the REPL entry's process-lifecycle wiring
// (src/entrypoints/cli.tsx). `wireShutdown` is exported specifically so this
// can be exercised without mounting the REPL: importing cli.tsx does not
// select a provider, connect MCP servers or render anything, because its
// side-effecting `main()` only runs behind `if (import.meta.main)` — true
// only when Bun runs the file directly (see the guard's comment in the
// source), never true here under Vitest/Node.
//
// The bug this guards: `mcp.shutdown()` is genuinely async
// (StdioClientTransport.close() races a close against a timeout before
// killing the child), but it used to be fired from `process.on('exit', ...)`.
// Node's `'exit'` handlers must be synchronous — anything async started
// there never runs because the process ends the moment the handler returns
// — so the kill signal to a stdio MCP child never actually went out, leaving
// it orphaned. Separately, `process.on('SIGINT', ...)` was registered
// without ever calling `process.exit()`, so registering the listener at all
// (which replaces Node's default immediate-exit-on-SIGINT behaviour) left
// the process hanging under a non-TTY stdin instead of exiting.

import { describe, expect, it, vi } from 'vitest';

import { wireShutdown } from '../src/entrypoints/cli.tsx';

interface FakeProcess {
  on: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
}

function fakeProcess(): FakeProcess {
  const proc = {
    on: vi.fn((_event: string, _handler: () => void) => proc),
    exit: vi.fn(),
  };
  return proc;
}

function handlerFor(proc: FakeProcess, event: string): () => void {
  const call = proc.on.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`no handler registered for ${event}`);
  return call[1] as () => void;
}

describe('wireShutdown', () => {
  it('awaits mcp.shutdown before exiting on SIGINT', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shutdown = vi.fn(() => gate);
    const proc = fakeProcess();

    // biome-ignore lint/suspicious/noExplicitAny: a partial process double is exactly the point
    wireShutdown({ shutdown }, proc as any);
    handlerFor(proc, 'SIGINT')();

    expect(shutdown).toHaveBeenCalledTimes(1);
    // The old code called shutdown() but never awaited it — exit therefore
    // must not fire until the shutdown promise actually settles.
    expect(proc.exit).not.toHaveBeenCalled();

    release?.();
    await gate;
    await Promise.resolve();
    await Promise.resolve();

    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('awaits mcp.shutdown before exiting on SIGTERM too', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const proc = fakeProcess();

    // biome-ignore lint/suspicious/noExplicitAny: a partial process double is exactly the point
    wireShutdown({ shutdown }, proc as any);
    handlerFor(proc, 'SIGTERM')();
    await Promise.resolve();
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('runs shutdown on beforeExit, where async work actually executes', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const proc = fakeProcess();

    // biome-ignore lint/suspicious/noExplicitAny: a partial process double is exactly the point
    wireShutdown({ shutdown }, proc as any);
    handlerFor(proc, 'beforeExit')();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('never registers a handler on the exit event', () => {
    // A handler here would be silently useless: 'exit' handlers run
    // synchronously and the process is gone before an async shutdown could
    // ever complete. Asserting there is no listener at all keeps the fix
    // from quietly regressing back to that dead code path.
    const shutdown = vi.fn(() => Promise.resolve());
    const proc = fakeProcess();

    // biome-ignore lint/suspicious/noExplicitAny: a partial process double is exactly the point
    wireShutdown({ shutdown }, proc as any);

    const registered = proc.on.mock.calls.map((c) => c[0]);
    expect(registered).not.toContain('exit');
    expect(registered).toContain('SIGINT');
    expect(registered).toContain('SIGTERM');
    expect(registered).toContain('beforeExit');
  });
});
