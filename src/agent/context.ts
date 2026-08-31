// Per-turn session context. The daemon enters a session with the chatId
// before running each turn, the REPL uses a fixed 'repl' id, and tools
// that hold state (tasks, plan mode, worktrees, browser, monitors) key
// their data by the current session id so users never see each other's
// stuff.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AgentSession {
  /** Stable identifier — chatId for bot turns, 'repl' for the local REPL,
   *  parent session id for sub-agents (so they share state with the parent). */
  id: string;
  /** Source channel — informational, used by tools that want to behave
   *  differently in bot vs REPL contexts. */
  scope: 'repl' | 'telegram' | 'sub-agent' | 'scheduled' | 'unknown';
  /**
   * Per-run override of `permissions.headless` (tools/bash-gate.ts), scoped to
   * this session only — never written to the stored config.
   *
   * `asterisk run --allow-tools` is the one caller that sets this today: an
   * explicit, process-lifetime-only flag rather than a config edit, so the
   * grant is visible in the run's own argv instead of hiding in a file, and
   * never widens what the REPL, the daemon or a bot transport does with an
   * unattended prompt. See src/run/cli.ts for the reasoning.
   */
  headlessOverride?: 'deny' | 'allow';
}

const store = new AsyncLocalStorage<AgentSession>();

const DEFAULT_SESSION: AgentSession = { id: 'default', scope: 'unknown' };

export function currentSession(): AgentSession {
  return store.getStore() ?? DEFAULT_SESSION;
}

export function currentSessionId(): string {
  return currentSession().id;
}

export function runWithSession<T>(session: AgentSession, fn: () => Promise<T>): Promise<T> {
  return store.run(session, fn);
}
