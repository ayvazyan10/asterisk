import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import {
  MAX_TASK_SESSIONS,
  _resetTasksForTesting,
  taskCreateTool,
  taskGetTool,
  taskListTool,
  taskStopTool,
  taskUpdateTool,
} from '../src/tools/tasks.ts';

describe('task tools', () => {
  beforeEach(() => _resetTasksForTesting());
  afterEach(() => _resetTasksForTesting());

  it('TaskCreate requires title', async () => {
    const r = await taskCreateTool.execute({});
    expect(r.isError).toBe(true);
  });

  it('TaskCreate / TaskList / TaskGet round-trip', async () => {
    const c = await taskCreateTool.execute({ title: 'first', description: 'do a thing' });
    expect(c.isError).toBe(false);
    expect(c.output).toMatch(/created task 1/);

    const list = await taskListTool.execute({});
    expect(list.output).toMatch(/first/);
    expect(list.output).toMatch(/total 1/);

    const get = await taskGetTool.execute({ id: '1' });
    expect(get.output).toMatch(/title:\s+first/);
    expect(get.output).toMatch(/status:\s+pending/);
  });

  it('TaskUpdate moves status', async () => {
    await taskCreateTool.execute({ title: 'go' });
    const u = await taskUpdateTool.execute({ id: '1', status: 'in_progress' });
    expect(u.isError).toBe(false);
    expect(u.output).toMatch(/in_progress/);
    const list = await taskListTool.execute({ status: 'in_progress' });
    expect(list.output).toMatch(/go/);

    const get = await taskGetTool.execute({ id: '1' });
    expect(get.output).toMatch(/status:\s+in_progress/);
  });

  it('TaskUpdate rejects invalid status', async () => {
    await taskCreateTool.execute({ title: 'x' });
    const u = await taskUpdateTool.execute({ id: '1', status: 'kaboom' });
    expect(u.isError).toBe(true);
  });

  it('TaskStop cancels and notes the reason', async () => {
    await taskCreateTool.execute({ title: 'meh' });
    const s = await taskStopTool.execute({ id: '1', reason: 'replaced' });
    expect(s.isError).toBe(false);
    const get = await taskGetTool.execute({ id: '1' });
    expect(get.output).toMatch(/status:\s+cancelled/);
    expect(get.output).toMatch(/replaced/);
  });

  it('TaskList filters by status', async () => {
    await taskCreateTool.execute({ title: 'a' });
    await taskCreateTool.execute({ title: 'b' });
    await taskUpdateTool.execute({ id: '2', status: 'completed' });
    const completed = await taskListTool.execute({ status: 'completed' });
    expect(completed.output).toMatch(/b/);
    expect(completed.output).not.toMatch(/(?:^|\s)a$/m);
  });

  it('unknown id surfaces an error', async () => {
    const r = await taskGetTool.execute({ id: '999' });
    expect(r.isError).toBe(true);
  });

  it('caps per-session growth: the oldest idle session is evicted, not kept forever', async () => {
    // Create one session more than the cap allows, each with its own task,
    // then check the very first session's tasks are gone while a session
    // created near the end still has its task. On the old, uncapped Map
    // this never evicts anything, so `first` would still be found.
    const sessionCount = MAX_TASK_SESSIONS + 1;
    for (let i = 0; i < sessionCount; i++) {
      await runWithSession({ id: `sess-${i}`, scope: 'unknown' }, async () => {
        await taskCreateTool.execute({ title: `task for ${i}` });
      });
    }

    const first = await runWithSession({ id: 'sess-0', scope: 'unknown' }, () =>
      taskListTool.execute({}),
    );
    expect(first.output).toBe('(no tasks)');

    const recent = await runWithSession({ id: `sess-${sessionCount - 1}`, scope: 'unknown' }, () =>
      taskListTool.execute({}),
    );
    expect(recent.output).toMatch(new RegExp(`task for ${sessionCount - 1}`));
  });
});
