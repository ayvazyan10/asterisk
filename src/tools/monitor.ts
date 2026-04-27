// Monitor tool — start/tail/stop a long-running background command without
// blocking the agent loop. The command runs detached; stdout+stderr are
// appended to ~/.asterisk/monitors/<id>.log; PID is tracked separately so
// the agent can revisit later turns to see what's been happening.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Tool, ok, err } from './types.ts';

const MONITORS_DIR = join(
  process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'),
  'monitors',
);

interface MonitorRecord {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  logFile: string;
}

const monitors = new Map<string, MonitorRecord>();

function ensureDir() {
  if (!existsSync(MONITORS_DIR)) mkdirSync(MONITORS_DIR, { recursive: true });
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
      if (monitors.size === 0) return ok('(no active monitors)');
      const lines: string[] = [];
      for (const m of monitors.values()) {
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
      const logFile = join(MONITORS_DIR, `${id}.log`);
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
      monitors.set(id, record);
      return ok(`✓ started monitor ${id} · pid ${child.pid}\n  log: ${logFile}`);
    }

    if (action === 'tail') {
      const id = typeof input['id'] === 'string' ? input['id'] : '';
      const m = monitors.get(id);
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
      const m = monitors.get(id);
      if (!m) return err(`no monitor with id ${id}`);
      try {
        process.kill(m.pid, 'SIGTERM');
      } catch (e) {
        return err(`kill failed: ${(e as Error).message}`);
      }
      monitors.delete(id);
      return ok(`✓ stopped ${m.id} (pid ${m.pid})`);
    }

    return err(`unknown action: ${action}`);
  },
};

export const MONITOR_TOOLS: Tool[] = [monitorTool];
