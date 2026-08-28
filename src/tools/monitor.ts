// Monitor tool — start/tail/stop a long-running background command without
// blocking the agent loop. The command runs detached; stdout+stderr are
// appended to ~/.asterisk/monitors/<id>.log; PID is tracked separately so
// the agent can revisit later turns to see what's been happening.
//
// Session state is capped (MAX_MONITOR_SESSIONS), the same growth bound
// entrypoints/daemon.ts applies to resident chat state — otherwise a
// long-lived daemon talking to many distinct sessions accumulates one Map
// entry per session forever. Unlike tasks.ts (disposable scratch state) a
// monitor session can hold live PIDs, so eviction here skips any session
// that still has a running process: forgetting it would orphan that
// process — nothing could Monitor(action=stop/tail) it again — which is
// worse than letting the map grow a little past the cap until the process
// exits or is explicitly stopped.
//
// That still leaves the harder case: if the *daemon itself* restarts, every
// resident Map — capped or not — is gone from memory, and any detached
// process it had spawned keeps running with nothing tracking it any more.
// Fixing that needs the PID/command/log path persisted to disk so a fresh
// process can rediscover and re-adopt them, which is a larger change than
// this fix covers and is left open.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { currentSessionId } from '../agent/context.ts';
import { type Tool, err, ok } from './types.ts';

// Computed lazily, not as a module-level constant — see schedule.ts for why.
function monitorsDir(): string {
  return join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'monitors');
}

interface MonitorRecord {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  logFile: string;
}

export const MAX_MONITOR_SESSIONS = 200;

const monitorsBySession = new Map<string, Map<string, MonitorRecord>>();

export function _resetMonitorsForTesting(): void {
  monitorsBySession.clear();
}

/** Direct size introspection for tests — the cap is on Map growth, which
 *  isn't otherwise observable through the tool's own actions. */
export function _sessionCountForTesting(): number {
  return monitorsBySession.size;
}

function evictIdleSessions(): void {
  for (const [sid, recs] of monitorsBySession) {
    if (monitorsBySession.size <= MAX_MONITOR_SESSIONS) return;
    const stillRunning = [...recs.values()].some((m) => isAlive(m.pid));
    if (!stillRunning) monitorsBySession.delete(sid);
  }
}

function monitors(): Map<string, MonitorRecord> {
  const sid = currentSessionId();
  const existing = monitorsBySession.get(sid);
  if (existing) {
    // Refresh recency, same reasoning as tasks.ts / entrypoints/daemon.ts.
    monitorsBySession.delete(sid);
    monitorsBySession.set(sid, existing);
    return existing;
  }
  const m = new Map<string, MonitorRecord>();
  monitorsBySession.set(sid, m);
  evictIdleSessions();
  return m;
}

function ensureDir() {
  const dir = monitorsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function nextId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tailFile(file: string, lines: number): string {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  const all = text.split('\n');
  const tail = all.slice(Math.max(0, all.length - lines)).join('\n');
  return tail;
}

export const monitorTool: Tool = {
  name: 'Monitor',
  description:
    'Manage long-running background commands. action="start" spawns one detached and returns its id. action="tail" returns the latest output (and whether it\'s still running). action="stop" sends SIGTERM. action="list" enumerates active monitors.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'start | tail | stop | list' },
      command: { type: 'string', description: 'Shell command (for action=start).' },
      id: { type: 'string', description: 'Monitor id (for tail/stop).' },
      lines: { type: 'number', description: 'Tail length for action=tail (default 50).' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(input) {
    const action = typeof input['action'] === 'string' ? input['action'] : '';
    if (action === 'list') {
      const live = monitors();
      if (live.size === 0) return ok('(no active monitors)');
      const lines: string[] = [];
      for (const m of live.values()) {
        const alive = isAlive(m.pid);
        const elapsed = Math.round((Date.now() - m.startedAt) / 1000);
        lines.push(
          `  ${alive ? '●' : '○'} ${m.id}  ${alive ? 'running' : 'exited'}  · pid ${m.pid} · ${elapsed}s · ${m.command}`,
        );
      }
      return ok(['Monitors:', ...lines].join('\n'));
    }

    if (action === 'start') {
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      if (!command) return err('command is required for action=start');
      ensureDir();
      const id = nextId();
      const logFile = join(monitorsDir(), `${id}.log`);
      const out = openSync(logFile, 'a');
      const err_ = openSync(logFile, 'a');
      const child = spawn('bash', ['-lc', command], {
        detached: true,
        stdio: ['ignore', out, err_],
      });
      child.unref();
      if (!child.pid) return err('failed to spawn');
      const record: MonitorRecord = {
        id,
        command,
        pid: child.pid,
        startedAt: Date.now(),
        logFile,
      };
      monitors().set(id, record);
      return ok(`✓ started monitor ${id} · pid ${child.pid}\n  log: ${logFile}`);
    }

    if (action === 'tail') {
      const id = typeof input['id'] === 'string' ? input['id'] : '';
      const m = monitors().get(id);
      if (!m) return err(`no monitor with id ${id}`);
      const lines = typeof input['lines'] === 'number' ? input['lines'] : 50;
      const alive = isAlive(m.pid);
      const tail = tailFile(m.logFile, Math.max(1, Math.min(lines, 1000)));
      let logSize = 0;
      try {
        logSize = statSync(m.logFile).size;
      } catch {}
      const header = `${m.id} · ${alive ? 'running' : 'exited'} · pid ${m.pid} · log ${logSize} bytes`;
      return ok(`${header}\n---\n${tail || '(no output yet)'}`);
    }

    if (action === 'stop') {
      const id = typeof input['id'] === 'string' ? input['id'] : '';
      const m = monitors().get(id);
      if (!m) return err(`no monitor with id ${id}`);
      try {
        process.kill(m.pid, 'SIGTERM');
      } catch (e) {
        return err(`kill failed: ${(e as Error).message}`);
      }
      monitors().delete(id);
      return ok(`✓ stopped ${m.id} (pid ${m.pid})`);
    }

    return err(`unknown action: ${action}`);
  },
};

export const MONITOR_TOOLS: Tool[] = [monitorTool];
