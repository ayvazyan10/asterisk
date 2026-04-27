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
  scope: 'repl' | 'telegram' | 'whatsapp' | 'sub-agent' | 'scheduled' | 'unknown';
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
