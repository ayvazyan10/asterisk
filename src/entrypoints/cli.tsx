#!/usr/bin/env bun
// Asterisk REPL entry. Selects a provider based on env, connects MCP servers,
// then mounts the Ink app.

import { render } from 'ink';
import React from 'react';

import { createAgentState } from '../agent/loop.ts';
import { loadConversation } from '../agent/persistence.ts';
import { loadConfig } from '../config/load.ts';
import { type McpManager, createMcpManager } from '../mcp/manager.ts';
import { chooseProvider } from '../providers/factory.ts';
import { App } from '../repl/App.tsx';
import { setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';

function pickProvider(): Provider {
  const loaded = loadConfig();

  // ASTERISK_PROVIDER overrides the stored choice for one run.
  const explicit = (process.env['ASTERISK_PROVIDER'] ?? '').toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai-compatible') {
    loaded.config = { ...loaded.config, provider: explicit };
  }

  const chosen = chooseProvider(loaded);
  if (chosen.fallbackReason) {
    console.error(`asterisk: ${chosen.fallbackReason} — using ${chosen.kind}`);
  }
  return chosen.provider;
}

/**
 * Wires the MCP manager's shutdown into process lifecycle events.
 *
 * `'exit'` handlers in Node must be synchronous — anything async started
 * there never runs because the process ends the moment the handler returns.
 * `mcp.shutdown()` genuinely is async (StdioClientTransport.close() races a
 * close against a 2s timeout before it signals the child), so a `void
 * mcp.shutdown()` from `'exit'` dropped the kill on the floor and left every
 * stdio MCP server orphaned. `'beforeExit'` fires while the event loop is
 * still alive — once Ink unmounts after `/quit`, or stdin closes on a
 * non-TTY run — so the same cleanup runs there instead, where awaiting it
 * actually does something.
 *
 * SIGINT previously had no handler that called `process.exit()` either:
 * registering a `'SIGINT'` listener at all replaces Node's default
 * immediate-exit behaviour, and without an explicit exit the process just
 * kept running once the listener returned — invisible at an interactive TTY
 * (Ctrl+C looks like it worked because Ink's own raw-mode handling tends to
 * unmount the app), but a real hang under a non-TTY stdin (a pipe, a
 * script). SIGTERM gets the same treatment for the same reason. Compare
 * src/entrypoints/mcp-server.ts's `shutdown`, which already gets this right.
 *
 * Exported so the wiring can be exercised without mounting the REPL: see
 * tests/cli-shutdown.test.ts.
 */
export function wireShutdown(
  mcp: Pick<McpManager, 'shutdown'>,
  proc: Pick<NodeJS.Process, 'on' | 'exit'> = process,
): void {
  const shutdownAndExit = (code: number): void => {
    void mcp.shutdown().finally(() => proc.exit(code));
  };
  proc.on('SIGINT', () => shutdownAndExit(0));
  proc.on('SIGTERM', () => shutdownAndExit(0));
  proc.on('beforeExit', () => {
    void mcp.shutdown();
  });
}

function main(): void {
  let provider: Provider;
  try {
    provider = pickProvider();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`asterisk: could not start — ${message}\n`);
    process.stderr.write(
      'asterisk: check ~/.asterisk/config.json.broken (if present) and ~/.asterisk/asterisk.db, ' +
        'or move ~/.asterisk aside to start fresh.\n',
    );
    process.exit(1);
  }

  const state = createAgentState();
  state.history = loadConversation('repl');
  const mcp = createMcpManager();

  // Connect any pre-configured MCP servers in the background. We don't block
  // REPL startup on this — the user sees `/mcp list` reflecting state once the
  // connections finish (or fail).
  void mcp
    .reload()
    .then(() => setExtraTools(mcp.tools))
    .catch(() => {
      /* a failed MCP server is reported via /mcp list, not a startup crash */
    });

  wireShutdown(mcp);

  render(<App initialProvider={provider} state={state} mcp={mcp} />);
}

// Guards the side-effecting entry point so importing this module — as
// tests/cli-shutdown.test.ts does, to reach `wireShutdown` — never selects a
// provider, connects MCP servers or mounts the REPL. `import.meta.main` is
// true only when Bun runs this file directly, which is the only way the real
// CLI is ever launched (bin/asterisk execs `bun`, and the bundler targets
// `bun`); Vitest runs on Node, where the property is simply absent.
if (import.meta.main) main();
