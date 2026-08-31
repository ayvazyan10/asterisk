// Sub-agent dispatcher — lets the parent agent fan out research/exploration
// to a fresh agent loop with isolated state. Useful for deep dives without
// polluting the main conversation history.
//
// Implementation: shares the parent's Provider/MCP/rules/hooks but creates a
// fresh AgentState. maxTurns is capped lower (default 8) than the parent
// loop so the sub-task can't run forever.

import { currentSession } from '../agent/context.ts';
import { type AgentState, createAgentState, runAgentTurn } from '../agent/loop.ts';
import { findAgent, loadAgents } from '../agents/loader.ts';
import { loadConfig } from '../config/load.ts';
import { createProviderFromConfig } from '../providers/factory.ts';
import { loadRules } from '../rules/loader.ts';
import type { Provider } from '../types/messages.ts';
import { type Tool, type ToolExecuteOptions, type ToolResult, err, ok } from './types.ts';

const DEFAULT_SUB_MAX_TURNS = 32;
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
  // Rebuild from config through the shared factory, so a sub-agent always
  // runs on the same backend and settings as the parent.
  return createProviderFromConfig(loadConfig());
}

function describeAgent(): string {
  // Keep the description tight — every byte here is parsed by the model on
  // EVERY turn. Listing all 27+ sub-agent types inline (with descriptions)
  // was costing ~3KB of prompt-eval per turn, ~100s on qwen3.5:9b. The
  // model gets just the names; full descriptions live behind /agents.
  const names = loadAgents()
    .map((a) => a.name)
    .filter((n) => n !== 'general-purpose') // implicit default
    .join(', ');
  return `Spawn a sub-agent in an isolated conversation. Use for parallel investigations or to hand work to a domain specialist (code-reviewer, security-reviewer, planner, explore, …). Omit subagent_type to spawn a general-purpose sub-agent with your full tool-set; set it to a specialised role for a tailored prompt + restricted tools. Sub-agent inherits your session (tasks/worktrees/browser visible to you) but runs with its own AgentState.

Available subagent_type: ${names}.`;
}

export const subAgentTool: Tool = {
  name: 'Agent',
  // The description is recomputed at registration time to include the
  // current bundled+user agent list. A small wrapper below assigns it.
  description: describeAgent(),
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Task description for the sub-agent. Include enough context — it starts with no shared history.',
      },
      subagent_type: {
        type: 'string',
        description:
          'Optional. Name of a specialised agent type (see description above). Defaults to general-purpose.',
      },
      maxTurns: {
        type: 'number',
        description:
          "Cap on the sub-agent's tool-use turns (default 8 unless the agent type sets a higher cap, max 20).",
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
    if (!prompt) return err('prompt is required');
    const requestedType =
      typeof input['subagent_type'] === 'string' ? input['subagent_type'].trim() : '';
    const maxTurns = typeof input['maxTurns'] === 'number' ? input['maxTurns'] : undefined;
    return await runSubAgent(
      {
        prompt,
        ...(requestedType ? { type: requestedType } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      },
      opts,
    );
  },
};

export interface SubAgentRequest {
  prompt: string;
  /** Specialised agent type; general-purpose when omitted. */
  type?: string;
  maxTurns?: number;
}

/**
 * Runs one sub-agent to completion.
 *
 * Extracted from the `Agent` tool so `AgentBatch` can dispatch several without
 * duplicating the provider, rules, hooks and session plumbing — the kind of
 * duplication that produced four drifting copies of `pickProvider` before
 * providers/factory.ts existed.
 */
export async function runSubAgent(
  req: SubAgentRequest,
  opts?: ToolExecuteOptions,
): Promise<ToolResult> {
  const prompt = req.prompt;
  const requestedType = req.type ?? '';

  const agentType = requestedType ? findAgent(requestedType) : findAgent('general-purpose');
  if (requestedType && !agentType) {
    const available = loadAgents()
      .map((a) => a.name)
      .slice(0, 20)
      .join(', ');
    return err(
      `unknown subagent_type "${requestedType}". Available: ${available} (and more — check /agents).`,
    );
  }

  const turnsCap = agentType?.maxTurns ?? DEFAULT_SUB_MAX_TURNS;
  const maxTurns = Math.min(Math.max(req.maxTurns ?? turnsCap, 1), 20);

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
    const allowedTools = agentType?.allowedTools;
    const runOpts: Parameters<typeof runAgentTurn>[3] = {
      // Spread first so a sub-agent inherits every per-session field the
      // parent carries (today just headlessOverride, from `asterisk run
      // --allow-tools`) without this file having to know each one by name —
      // only `scope` is deliberately different from the parent's.
      session: { ...parent, scope: 'sub-agent' },
      maxTurns,
      maxRetries: DEFAULT_SUB_MAX_RETRIES,
      rules,
      hooks,
      // A sub-agent starts with an empty history and is capped at a handful
      // of turns, so it rarely compacts at all — and when it does, paying for
      // a summarising model call nested inside the parent's turn buys very
      // little for the latency it adds.
      summariseDropped: false,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    };
    // Inject the agent type's specialised prompt as a soul block so it
    // composes with the standard system prompt + rules instead of
    // replacing them. Simpler than threading a separate parameter.
    if (agentType?.prompt) {
      runOpts.souls = [
        {
          scope: 'session',
          path: agentType.path,
          content: `# Sub-agent role: ${agentType.name}\n${agentType.prompt}`,
        },
      ];
    }
    if (allowedTools && allowedTools.length > 0) {
      runOpts.allowedTools = allowedTools;
    }
    const result = await runAgentTurn(provider, state, prompt, runOpts);
    const label = agentType ? `[${agentType.name}] ` : '';
    const tag =
      result.reason === 'end-turn'
        ? `${label}✓ sub-agent completed`
        : `${label}sub-agent ended: ${result.reason}`;
    return ok(`${tag}\n---\n${result.finalText || '(no text returned)'}`);
  } catch (e) {
    return err(`sub-agent failed: ${(e as Error).message}`);
  }
}
