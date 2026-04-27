// Specialized sub-agent types. The Agent tool can dispatch a fresh agent
// loop with a tailored system prompt + (optional) tool-set restriction so
// the parent agent can fan out work to a domain expert (code-reviewer,
// security-reviewer, etc.) without polluting its own context.
//
// Resolution order (in agents/loader.ts):
//   project-local  >  user-global  >  bundled
// so a user-installed `~/.asterisk/agents/code-reviewer.md` overrides the
// bundled one of the same name.

export interface AgentType {
  /** kebab-case identifier — e.g. 'code-reviewer'. */
  name: string;
  /** One-line summary, surfaced in /agents and as the description the
   *  parent model sees in the Agent tool's enum description. */
  description: string;
  /** Where this definition came from. */
  scope: 'bundled' | 'user' | 'project';
  /** Path or sentinel ('bundled:<name>') for diagnostics. */
  path: string;
  /** System prompt the sub-agent runs under. Should describe the role,
   *  the tools to lean on, the success criteria, and any restrictions. */
  prompt: string;
  /** If set, the sub-agent is restricted to this allow-list of tool names
   *  (e.g. read-only research agents). If unset, the sub-agent inherits
   *  the parent's full tool-set. */
  allowedTools?: readonly string[];
  /** Cap on the sub-agent's tool-use turns. Defaults to a low value (8)
   *  in subagent.ts; override here for agents that legitimately need more
   *  rounds (e.g. planner, refactor-cleaner) or fewer (statusline-setup). */
  maxTurns?: number;
}
