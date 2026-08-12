// AgentBatch — dispatch several sub-agents for one parent turn.
//
// `Agent` is single-shot: three independent questions cost three sequential
// round trips, each waiting out the last. This runs them together.
//
// The constraint that shapes the whole design: worktrees are process-global
// (`activeWorktree()` in worktree.ts), and sub-agents share the parent's tool
// state by design, so two agents editing files at once operate on one
// filesystem view with no isolation between them. Rather than documenting that
// as a caveat nobody reads, the batch decides for itself — a task whose agent
// type can write runs sequentially, and only read-only work goes in parallel.
// The concurrency you get is a property of what you asked for, not a promise
// you have to remember to keep.

import { findAgent } from '../agents/loader.ts';
import { runSubAgent } from './subagent.ts';
import { type Tool, type ToolExecuteOptions, err, ok } from './types.ts';

/** Ceiling on simultaneous sub-agents, whatever the batch asks for. */
const MAX_PARALLEL = 4;

/** Most tasks accepted in one call. */
const MAX_TASKS = 10;

interface BatchTask {
  prompt: string;
  subagent_type?: string;
}

/**
 * True when this agent type cannot modify files directly.
 *
 * A type with no `allowedTools` inherits the full set, so the absence of a
 * restriction reads as "can write" — the safe interpretation, and the reason
 * plain `general-purpose` never parallelises.
 *
 * `Bash` is deliberately not counted as mutating, even though a shell can
 * obviously write. Every read-only type in the bundled set carries it for
 * `git log`, `rg` and `ls`, so counting it would leave nothing parallel at all.
 * What makes that tolerable rather than wishful is the permission gate in
 * bash-gate.ts: the built-in allowlist is read-only commands, and anything
 * else needs the user to approve it — a sub-agent cannot quietly write through
 * the shell. Remove that gate and this classification stops being safe.
 */
function isReadOnly(type: string | undefined): boolean {
  const agent = findAgent(type ?? 'general-purpose');
  const allowed = agent?.allowedTools;
  if (!allowed || allowed.length === 0) return false;
  const mutating = ['Edit', 'Write', 'NotebookEdit'];
  return !allowed.some((t) => mutating.includes(t));
}

function parseTasks(raw: unknown): BatchTask[] | string {
  if (!Array.isArray(raw)) return 'tasks must be an array';
  if (raw.length === 0) return 'tasks must not be empty';
  if (raw.length > MAX_TASKS) return `too many tasks (${raw.length}); the limit is ${MAX_TASKS}`;

  const tasks: BatchTask[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) return `task ${i + 1} is not an object`;
    const record = entry as Record<string, unknown>;
    const prompt = typeof record['prompt'] === 'string' ? record['prompt'].trim() : '';
    if (!prompt) return `task ${i + 1} has no prompt`;
    const type = record['subagent_type'];
    tasks.push({
      prompt,
      ...(typeof type === 'string' && type.trim() ? { subagent_type: type.trim() } : {}),
    });
  }
  return tasks;
}

/** Runs `tasks` with at most `limit` in flight, preserving input order. */
async function runWithLimit<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (task) results[index] = await task();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function runOne(task: BatchTask, opts?: ToolExecuteOptions): Promise<string> {
  const label = task.subagent_type ?? 'general-purpose';
  try {
    const result = await runSubAgent(
      { prompt: task.prompt, ...(task.subagent_type ? { type: task.subagent_type } : {}) },
      opts,
    );
    return `### ${label}\n${result.output}`;
  } catch (e) {
    // One task failing must not lose the others' work, so the error becomes
    // this task's result rather than the batch's.
    return `### ${label}\nfailed: ${(e as Error).message}`;
  }
}

export const agentBatchTool: Tool = {
  name: 'AgentBatch',
  interactive: true,
  description:
    'Dispatch several sub-agents for one turn and return all their answers. Use when you have independent questions that do not depend on each other — parallel research, checking several files, gathering options. Read-only agent types run concurrently; anything that can write runs one after another, because sub-agents share one filesystem view. Each task starts with no shared history, so give it full context.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: `Up to ${MAX_TASKS} independent tasks.`,
        items: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'What this sub-agent should do.' },
            subagent_type: {
              type: 'string',
              description: 'Optional specialised agent type; see /agents.',
            },
          },
          required: ['prompt'],
        },
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },

  async execute(input, opts) {
    const parsed = parseTasks(input['tasks']);
    if (typeof parsed === 'string') return err(parsed);

    if (opts?.signal?.aborted) return err('batch cancelled before it started');

    const parallel = parsed.every((t) => isReadOnly(t.subagent_type));
    const thunks = parsed.map((task) => () => runOne(task, opts));

    const results = parallel
      ? await runWithLimit(thunks, MAX_PARALLEL)
      : await runWithLimit(thunks, 1);

    const mode = parallel
      ? `${parsed.length} tasks, up to ${MAX_PARALLEL} at a time`
      : `${parsed.length} tasks, one at a time (a requested agent type can modify files)`;

    return ok([`AgentBatch · ${mode}`, '', results.join('\n\n')].join('\n'));
  },
};
