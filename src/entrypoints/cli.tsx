#!/usr/bin/env bun
// Asterisk REPL entry. Selects a provider based on env, then mounts the Ink app.

import { render } from 'ink';
import React from 'react';

import { createAgentState } from '../agent/loop.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { App } from '../repl/App.tsx';
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

render(<App provider={provider} state={state} />);
