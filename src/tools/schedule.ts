// ScheduleWakeup, CronCreate, CronDelete, CronList — persistent scheduling
// of agent prompts. Stored in JSONL under ~/.asterisk/schedule/. The daemon
// polls these files every 30s and dispatches due items as agent turns.
//
// Reads and writes stay read-all/modify-in-memory/write-all — see the
// consumers below — but `writeJsonl` now goes through `writeOwnerOnlyAtomic`
// (temp file + rename in the same directory, same helper the conversation
// store uses), so a reader never observes a half-written file and a crash
// mid-write can no longer truncate the last line. It also puts these files
// under the same 0600 owner-only mode as the rest of ~/.asterisk, which
// plain `writeFileSync` never did. `readJsonl` additionally tolerates a
// line that fails to parse: it is skipped rather than thrown, so one
// corrupted line does not take every other job down with it.
//
// What this does NOT fix: the REPL and the daemon are separate processes
// sharing the same ~/.asterisk, and both can still race a plain
// read-modify-write — process A reads [], process B reads [], A writes
// [jobA], B writes [jobB], and jobA is silently gone. Closing that needs a
// real lock (flock via a sidecar lockfile, or moving scheduling into the
// existing SQLite store, which already serialises through one connection)
// and is out of scope for this fix.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ensureOwnerOnlyDir, writeOwnerOnlyAtomic } from '../utils/fs-safe.ts';
import { type Tool, err, ok } from './types.ts';

// Computed lazily rather than as a module-level constant: ASTERISK_HOME is
// read once, at call time, so tests (and anything else that sets it after
// this module was first imported — it is reachable transitively through the
// tool registry) get the directory they actually asked for.
function scheduleDir(): string {
  return join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'schedule');
}

function oneshotFile(): string {
  return join(scheduleDir(), 'oneshots.jsonl');
}

function cronFile(): string {
  return join(scheduleDir(), 'cron.jsonl');
}

export interface OneShot {
  id: string;
  prompt: string;
  fireAt: number;
  createdAt: number;
}

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const items: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as T);
    } catch {
      // A line a crash truncated mid-write, or (before writes were made
      // atomic below) one genuinely interleaved by another process — either
      // way, not grounds to lose every other job in the file.
    }
  }
  return items;
}

function writeJsonl<T>(file: string, items: T[]): void {
  ensureOwnerOnlyDir(scheduleDir());
  const body = items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
  writeOwnerOnlyAtomic(file, body);
}

export function readOneShots(): OneShot[] {
  return readJsonl<OneShot>(oneshotFile());
}

export function writeOneShots(items: OneShot[]): void {
  writeJsonl(oneshotFile(), items);
}

export function readCronJobs(): CronJob[] {
  return readJsonl<CronJob>(cronFile());
}

export function writeCronJobs(items: CronJob[]): void {
  writeJsonl(cronFile(), items);
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const scheduleWakeupTool: Tool = {
  name: 'ScheduleWakeup',
  description:
    'Schedule a one-shot agent prompt to fire after a delay. The Asterisk daemon picks it up and dispatches a fresh agent turn at fireAt. Useful for "remind me in 1 hour" or polling a long-running external job.',
  input_schema: {
    type: 'object',
    properties: {
      delaySeconds: {
        type: 'number',
        description: 'Seconds from now until the prompt fires (1 to 7 days).',
      },
      prompt: {
        type: 'string',
        description: 'The prompt the agent should be given when it wakes up.',
      },
    },
    required: ['delaySeconds', 'prompt'],
    additionalProperties: false,
  },
  async execute(input) {
    const delay = typeof input['delaySeconds'] === 'number' ? input['delaySeconds'] : 0;
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
    if (delay < 1 || delay > 7 * 86400) return err('delaySeconds must be 1..604800');
    if (!prompt) return err('prompt is required');
    const job: OneShot = {
      id: nextId('ws'),
      prompt,
      fireAt: Date.now() + delay * 1000,
      createdAt: Date.now(),
    };
    const all = readOneShots();
    all.push(job);
    writeOneShots(all);
    const fireAt = new Date(job.fireAt).toISOString();
    return ok(`✓ scheduled ${job.id} · fires at ${fireAt} (in ${delay}s)`);
  },
};

export const cronCreateTool: Tool = {
  name: 'CronCreate',
  description:
    'Schedule a recurring agent prompt using a 5-field cron expression (minute hour dom month dow). Examples: "0 9 * * 1-5" weekday 9am, "*/15 * * * *" every 15 minutes.',
  input_schema: {
    type: 'object',
    properties: {
      cron: { type: 'string', description: '5-field cron expression.' },
      prompt: { type: 'string', description: 'Prompt for each firing.' },
    },
    required: ['cron', 'prompt'],
    additionalProperties: false,
  },
  async execute(input) {
    const cron = typeof input['cron'] === 'string' ? input['cron'].trim() : '';
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'].trim() : '';
    if (!cron || cron.split(/\s+/).length !== 5)
      return err('cron must be a 5-field expression: minute hour dom month dow');
    if (!prompt) return err('prompt is required');
    const job: CronJob = {
      id: nextId('cron'),
      cron,
      prompt,
      enabled: true,
      createdAt: Date.now(),
    };
    const all = readCronJobs();
    all.push(job);
    writeCronJobs(all);
    return ok(`✓ cron ${job.id} created · ${cron} → "${prompt.slice(0, 60)}…"`);
  },
};

export const cronDeleteTool: Tool = {
  name: 'CronDelete',
  description: 'Delete a cron job by id.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(input) {
    const id = typeof input['id'] === 'string' ? input['id'] : '';
    const all = readCronJobs();
    const before = all.length;
    const next = all.filter((j) => j.id !== id);
    if (next.length === before) return err(`no cron job with id ${id}`);
    writeCronJobs(next);
    return ok(`✓ deleted cron ${id}`);
  },
};

export const cronListTool: Tool = {
  name: 'CronList',
  description: 'List configured cron jobs and pending one-shot wakeups.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    const cron = readCronJobs();
    const ones = readOneShots().filter((j) => j.fireAt > Date.now());
    const lines: string[] = [];
    if (cron.length === 0) lines.push('Cron jobs: (none)');
    else {
      lines.push('Cron jobs:');
      for (const j of cron) {
        const dot = j.enabled ? '●' : '○';
        lines.push(`  ${dot} ${j.id}  ${j.cron}  → ${j.prompt.slice(0, 70)}`);
      }
    }
    lines.push('');
    if (ones.length === 0) lines.push('One-shots: (none)');
    else {
      lines.push('One-shots:');
      for (const j of ones) {
        const sec = Math.max(0, Math.round((j.fireAt - Date.now()) / 1000));
        lines.push(`  ⏱ ${j.id}  in ${sec}s  → ${j.prompt.slice(0, 70)}`);
      }
    }
    return ok(lines.join('\n'));
  },
};

export const SCHEDULE_TOOLS: Tool[] = [
  scheduleWakeupTool,
  cronCreateTool,
  cronDeleteTool,
  cronListTool,
];
