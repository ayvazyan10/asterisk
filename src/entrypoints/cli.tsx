#!/usr/bin/env bun
// Asterisk REPL entry. Selects a provider based on env, connects MCP servers,
// then mounts the Ink app.

import { render } from 'ink';
import React from 'react';

import { createAgentState } from '../agent/loop.ts';
import { loadConversation } from '../agent/persistence.ts';
import { createMcpManager } from '../mcp/manager.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { App } from '../repl/App.tsx';
import { setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';

function pickProvider(): Provider {
  const explicit = (process.env['ASTERISK_PROVIDER'] ?? '').toLowerCase();
  if (explicit === 'anthropic') return createAnthropicProvider();
  if (explicit === 'ollama') return createOllamaProvider();

  // Auto: prefer Anthropic only when an API key is present AND user opts in
  // by setting ASTERISK_USE_ANTHROPIC=1; otherwise default to Ollama.
  if (process.env['ANTHROPIC_API_KEY'] && process.env['ASTERISK_USE_ANTHROPIC'] === '1') {
    return createAnthropicProvider();
  }
  return createOllamaProvider();
}

const provider = pickProvider();
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

process.on('SIGINT', () => {
  void mcp.shutdown();
});
process.on('exit', () => {
  void mcp.shutdown();
});

render(<App initialProvider={provider} state={state} mcp={mcp} />);
