// Sub-agent dispatcher — lets the parent agent fan out research/exploration
// to a fresh agent loop with isolated state. Useful for deep dives without
// polluting the main conversation history.
//
// Implementation: shares the parent's Provider/MCP/rules/hooks but creates a
// fresh AgentState. maxTurns is capped lower (default 8) than the parent
// loop so the sub-task can't run forever.

import { type AgentState, createAgentState, runAgentTurn } from '../agent/loop.ts';
import { currentSession } from '../agent/context.ts';
import { loadConfig } from '../config/load.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { loadRules } from '../rules/loader.ts';
import { type Tool, ok, err } from './types.ts';
import type { Provider } from '../types/messages.ts';

const DEFAULT_SUB_MAX_TURNS = 8;
const DEFAULT_SUB_MAX_RETRIES = 3;

interface SubAgentDeps {
  provider: Provider;
}

let deps: SubAgentDeps | null = null;

export function setSubAgentProvider(provider: Provider): void {
  deps = { provider };
}

function pickProviderForSub(): Provider {
  if (deps?.provider) return deps.provider;
  // Fallback: rebuild from config the same way main entry points do.
  const cfg = loadConfig();
  if (cfg.config.provider === 'anthropic' && cfg.secrets.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({
      apiKey: cfg.secrets.ANTHROPIC_API_KEY,
      model: cfg.config.anthropic.model,
    });
  }
  return createOllamaProvider({
    baseUrl: cfg.config.ollama.baseUrl,
    model: cfg.config.ollama.model,
    contextWindow: cfg.config.ollama.contextWindow,
  });
}

export const subAgentTool: Tool = {
  name: 'Agent',
  description:
    'Spawn a sub-agent in an isolated conversation to research, explore, or perform a focused task. Useful for parallel investigations without polluting the main turn. Returns the sub-agent\'s final text. The sub-agent has the same tools you do, but its conversation does not affect yours.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Task description for the sub-agent. Include enough context — it starts with no shared history.',
      },
      maxTurns: {
        type: 'number',
        description: 'Cap on the sub-agent\'s tool-use turns (default 8, max 20).',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
    if (!prompt) return err('prompt is required');
    const maxTurns = Math.min(
      Math.max(
        typeof input['maxTurns'] === 'number' ? input['maxTurns'] : DEFAULT_SUB_MAX_TURNS,
        1,
      ),
      20,
    );

    const provider = pickProviderForSub();
    const state: AgentState = createAgentState();
    const rules = loadRules();
    const hooks = loadConfig().config.hooks;

    // Sub-agents inherit the parent's session so any tasks they create,
    // worktrees they enter, etc. show up in the parent's view too. The
    // sub-agent runs in a fresh AgentState so the parent's conversation
    // history isn't polluted, but tool state stays shared.
    const parent = currentSession();
    try {
      const result = await runAgentTurn(provider, state, prompt, {
        session: { id: parent.id, scope: 'sub-agent' },
        maxTurns,
        maxRetries: DEFAULT_SUB_MAX_RETRIES,
        rules,
        hooks,
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
      const tag =
        result.reason === 'end-turn'
          ? '✓ sub-agent completed'
          : `sub-agent ended: ${result.reason}`;
      return ok(`${tag}\n---\n${result.finalText || '(no text returned)'}`);
    } catch (e) {
      return err(`sub-agent failed: ${(e as Error).message}`);
    }
  },
};
