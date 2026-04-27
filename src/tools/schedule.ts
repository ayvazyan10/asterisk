// ScheduleWakeup, CronCreate, CronDelete, CronList — persistent scheduling
// of agent prompts. Stored in JSONL under ~/.asterisk/schedule/. The daemon
// polls these files every 30s and dispatches due items as agent turns.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Tool, ok, err } from './types.ts';

const SCHEDULE_DIR = join(
  process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'),
  'schedule',
);
const ONESHOT_FILE = join(SCHEDULE_DIR, 'oneshots.jsonl');
const CRON_FILE = join(SCHEDULE_DIR, 'cron.jsonl');

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

function ensureDir(): void {
  if (!existsSync(SCHEDULE_DIR)) mkdirSync(SCHEDULE_DIR, { recursive: true });
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

function writeJsonl<T>(file: string, items: T[]): void {
  ensureDir();
  writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
}

export function readOneShots(): OneShot[] {
  return readJsonl<OneShot>(ONESHOT_FILE);
}

export function writeOneShots(items: OneShot[]): void {
  writeJsonl(ONESHOT_FILE, items);
}

export function readCronJobs(): CronJob[] {
  return readJsonl<CronJob>(CRON_FILE);
}

export function writeCronJobs(items: CronJob[]): void {
  writeJsonl(CRON_FILE, items);
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
