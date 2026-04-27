// Task tracker tools — give the agent its own todo list. Useful when it
// plans multi-step work and wants to mark progress as it goes. State lives
// in-memory for the lifetime of the Asterisk process; resets across REPL
// restarts. Five tools: TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop.

import { type Tool, ok, err } from './types.ts';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface AgentTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, AgentTask>();
let nextId = 1;

export function _resetTasksForTesting(): void {
  tasks.clear();
  nextId = 1;
}

export function _allTasks(): AgentTask[] {
  return [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function fmtTask(t: AgentTask): string {
  const icon =
    t.status === 'completed'
      ? '✓'
      : t.status === 'in_progress'
        ? '◐'
        : t.status === 'cancelled'
          ? '✗'
          : '○';
  return `${icon} ${t.id}  ${t.title}${t.description ? ` — ${t.description}` : ''}`;
}

export const taskCreateTool: Tool = {
  name: 'TaskCreate',
  description:
    'Create a task in the agent todo list. Returns the new task id. Use TaskUpdate to mark progress.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short imperative title.' },
      description: { type: 'string', description: 'Optional details.' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  async execute(input) {
    const title = typeof input['title'] === 'string' ? input['title'].trim() : '';
    if (!title) return err('title is required');
    const description =
      typeof input['description'] === 'string' ? input['description'].trim() : '';
    const id = String(nextId++);
    const now = Date.now();
    const task: AgentTask = {
      id,
      title,
      description,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    tasks.set(id, task);
    return ok(`created task ${id}: ${title}`);
  },
};

export const taskUpdateTool: Tool = {
  name: 'TaskUpdate',
  description:
    'Update a task: change its status (pending|in_progress|completed|cancelled), title, or description.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: {
        type: 'string',
        description: 'pending | in_progress | completed | cancelled',
      },
      title: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(input) {
    const id = typeof input['id'] === 'string' ? input['id'] : '';
    const task = tasks.get(id);
    if (!task) return err(`no task with id ${id}`);
    const status = typeof input['status'] === 'string' ? input['status'] : '';
    const allowed: TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (status && !allowed.includes(status as TaskStatus)) {
      return err(`status must be one of ${allowed.join(', ')}`);
    }
    if (status) task.status = status as TaskStatus;
    if (typeof input['title'] === 'string' && input['title'].trim())
      task.title = input['title'].trim();
    if (typeof input['description'] === 'string')
      task.description = input['description'].trim();
    task.updatedAt = Date.now();
    return ok(`updated #${task.id} → ${task.status} · ${task.title}`);
  },
};

export const taskListTool: Tool = {
  name: 'TaskList',
  description: 'List all tasks (or filter by status).',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Optional filter: pending | in_progress | completed | cancelled',
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const filter = typeof input['status'] === 'string' ? input['status'] : '';
    const all = _allTasks();
    const list = filter ? all.filter((t) => t.status === filter) : all;
    if (list.length === 0) return ok(filter ? `(no ${filter} tasks)` : '(no tasks)');
    const lines = list.map(fmtTask);
    const counts = countsFor(all);
    lines.push('');
    lines.push(
      `total ${all.length} · ${counts.in_progress} in_progress · ${counts.completed} completed · ${counts.pending} pending · ${counts.cancelled} cancelled`,
    );
    return ok(lines.join('\n'));
  },
};

export const taskGetTool: Tool = {
  name: 'TaskGet',
  description: 'Get the details of a single task by id.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(input) {
    const id = typeof input['id'] === 'string' ? input['id'] : '';
    const task = tasks.get(id);
    if (!task) return err(`no task with id ${id}`);
    const elapsedMs = Date.now() - task.createdAt;
    const lines = [
      `id:          ${task.id}`,
      `title:       ${task.title}`,
      `description: ${task.description || '(none)'}`,
      `status:      ${task.status}`,
      `created:     ${new Date(task.createdAt).toISOString()}  (${Math.round(elapsedMs / 1000)}s ago)`,
      `updated:     ${new Date(task.updatedAt).toISOString()}`,
    ];
    return ok(lines.join('\n'));
  },
};

export const taskStopTool: Tool = {
  name: 'TaskStop',
  description: 'Mark a task as cancelled. Equivalent to TaskUpdate with status=cancelled.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      reason: { type: 'string', description: 'Optional note appended to description.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(input) {
    const id = typeof input['id'] === 'string' ? input['id'] : '';
    const task = tasks.get(id);
    if (!task) return err(`no task with id ${id}`);
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    if (typeof input['reason'] === 'string' && input['reason'].trim()) {
      task.description = task.description
        ? `${task.description} · cancelled: ${input['reason'].trim()}`
        : `cancelled: ${input['reason'].trim()}`;
    }
    return ok(`cancelled · ${fmtTask(task)}`);
  },
};

function countsFor(list: readonly AgentTask[]): Record<TaskStatus, number> {
  const out: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const t of list) out[t.status]++;
  return out;
}

export const TASK_TOOLS: Tool[] = [
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  taskGetTool,
  taskStopTool,
];
