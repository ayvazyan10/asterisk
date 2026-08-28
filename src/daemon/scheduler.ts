// Daemon scheduler — polls one-shot wakeups and cron jobs every 30s,
// dispatches due items as fresh agent turns. Lives only inside the daemon
// (the REPL doesn't long-poll while idle).
//
// Cron expressions: standard 5 fields (minute hour dayOfMonth month dayOfWeek).
// Fields support  *  N  N-M  N,M,O  */N  with no further extensions.

import {
  type CronJob,
  type OneShot,
  readCronJobs,
  readOneShots,
  writeCronJobs,
  writeOneShots,
} from '../tools/schedule.ts';

export interface SchedulerOptions {
  intervalMs?: number;
  dispatch(prompt: string, source: string): Promise<void> | void;
  log(event: { type: string; [k: string]: unknown }): void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  // Reentrancy guard. setInterval does not wait for its callback to settle,
  // so without this a dispatch that outlives one tick interval (routine for
  // Bash, which the agent loop gives up to 15 minutes) would let a second,
  // third, … tick start concurrently. Per-minute dedup in shouldFireCron
  // alone does not cover this: once the wall-clock minute rolls over while
  // the first dispatch of a "* * * * *" job is still in flight, a fresh tick
  // sees a *different* minute and would legitimately consider the job due
  // again, even though its previous firing never returned. Serialising ticks
  // here caps concurrent dispatches at one, system-wide.
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await runOneShots();
      await runCronJobs();
    } finally {
      ticking = false;
    }
  }

  async function runOneShots(): Promise<void> {
    try {
      const now = Date.now();
      const oneShots = readOneShots();
      const due = oneShots.filter((j) => j.fireAt <= now);
      const remaining = oneShots.filter((j) => j.fireAt > now);
      // Persisted before dispatch: a job removed from the pending list can
      // never be picked up by another reader while its dispatch is running.
      if (due.length > 0) writeOneShots(remaining);
      for (const job of due) {
        opts.log({ type: 'oneshot_fire', id: job.id });
        try {
          await opts.dispatch(job.prompt, `oneshot:${job.id}`);
        } catch (e) {
          opts.log({ type: 'oneshot_error', id: job.id, error: (e as Error).message });
        }
      }
    } catch (e) {
      opts.log({ type: 'oneshot_poll_error', error: (e as Error).message });
    }
  }

  async function runCronJobs(): Promise<void> {
    try {
      const now = new Date();
      const cronJobs = readCronJobs();
      const due = cronJobs.filter(
        (job) => job.enabled && cronMatches(job.cron, now) && shouldFireCron(job, now),
      );
      // Persisted before dispatch, same as the one-shot branch above: a
      // dispatch that runs long must not leave a stale lastRunAt on disk for
      // another reader (or the next tick, absent the reentrancy guard) to
      // see and re-fire against.
      if (due.length > 0) {
        for (const job of due) job.lastRunAt = now.getTime();
        writeCronJobs(cronJobs);
      }
      for (const job of due) {
        opts.log({ type: 'cron_fire', id: job.id, cron: job.cron });
        try {
          await opts.dispatch(job.prompt, `cron:${job.id}`);
        } catch (e) {
          opts.log({ type: 'cron_error', id: job.id, error: (e as Error).message });
        }
      }
    } catch (e) {
      opts.log({ type: 'cron_poll_error', error: (e as Error).message });
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), interval);
      // Don't keep the process alive solely because of this timer.
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// Avoid double-firing within the same minute window.
function shouldFireCron(job: CronJob, now: Date): boolean {
  if (!job.lastRunAt) return true;
  const last = new Date(job.lastRunAt);
  return (
    last.getUTCFullYear() !== now.getUTCFullYear() ||
    last.getUTCMonth() !== now.getUTCMonth() ||
    last.getUTCDate() !== now.getUTCDate() ||
    last.getUTCHours() !== now.getUTCHours() ||
    last.getUTCMinutes() !== now.getUTCMinutes()
  );
}

// Parse a single cron field into a Set of integer values within [min,max].
// Supports: *, N, N-M, comma list, */step.
export function expandCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const piece of field.split(',')) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(piece);
    let range: string;
    let step = 1;
    if (stepMatch?.[1] && stepMatch[2]) {
      range = stepMatch[1];
      step = Math.max(1, Number.parseInt(stepMatch[2], 10));
    } else {
      range = piece;
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number.parseInt(a ?? '', 10);
      hi = Number.parseInt(b ?? '', 10);
    } else {
      const v = Number.parseInt(range, 10);
      lo = v;
      hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    lo = Math.max(min, lo);
    hi = Math.min(max, hi);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function cronMatches(expr: string, when: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  if (!minute || !hour || !dom || !month || !dow) return false;
  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  const doms = expandCronField(dom, 1, 31);
  const months = expandCronField(month, 1, 12);
  const dows = expandCronField(dow, 0, 6); // 0=Sunday

  return (
    minutes.has(when.getUTCMinutes()) &&
    hours.has(when.getUTCHours()) &&
    doms.has(when.getUTCDate()) &&
    months.has(when.getUTCMonth() + 1) &&
    dows.has(when.getUTCDay())
  );
}
