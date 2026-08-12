// Per-session isolation — verifies that two sessions (e.g. two Telegram
// chats) hitting the same daemon process don't see each other's tasks,
// plan-mode flag, worktrees, or monitors. Browser sessions are isolated
// the same way but harder to test without a real Chromium, so they're
// exercised manually via the REPL.

import { describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { isPlanMode, setPlanMode } from '../src/tools/planmode.ts';
import { _resetTasksForTesting, taskCreateTool, taskListTool } from '../src/tools/tasks.ts';

describe('per-session isolation', () => {
  it('Tasks created in session A are invisible to session B', async () => {
    _resetTasksForTesting();

    await runWithSession({ id: 'bot:111', scope: 'unknown' }, async () => {
      await taskCreateTool.execute({ title: "alice's task" });
    });
    await runWithSession({ id: 'bot:222', scope: 'unknown' }, async () => {
      await taskCreateTool.execute({ title: "bob's task" });
    });

    const aliceList = await runWithSession(
      { id: 'bot:111', scope: 'unknown' },
      () => taskListTool.execute({}) as Promise<{ output: string }>,
    );
    const bobList = await runWithSession(
      { id: 'bot:222', scope: 'unknown' },
      () => taskListTool.execute({}) as Promise<{ output: string }>,
    );

    expect(aliceList.output).toMatch(/alice's task/);
    expect(aliceList.output).not.toMatch(/bob's task/);
    expect(bobList.output).toMatch(/bob's task/);
    expect(bobList.output).not.toMatch(/alice's task/);

    _resetTasksForTesting();
  });

  it('Plan mode toggles independently per session', async () => {
    await runWithSession({ id: 'bot:111', scope: 'unknown' }, async () => {
      setPlanMode(true);
      expect(isPlanMode()).toBe(true);
    });

    // Different session — should still be off.
    await runWithSession({ id: 'bot:222', scope: 'unknown' }, async () => {
      expect(isPlanMode()).toBe(false);
      setPlanMode(true);
      expect(isPlanMode()).toBe(true);
    });

    // Back in 111 — its flag is still set.
    await runWithSession({ id: 'bot:111', scope: 'unknown' }, async () => {
      expect(isPlanMode()).toBe(true);
      setPlanMode(false);
    });

    // 222's flag is still set independently.
    await runWithSession({ id: 'bot:222', scope: 'unknown' }, async () => {
      expect(isPlanMode()).toBe(true);
      setPlanMode(false);
    });
  });

  it('Tasks survive between turns in the same session but not across sessions', async () => {
    _resetTasksForTesting();

    // Two consecutive "turns" in the same session.
    await runWithSession({ id: 'bot:333', scope: 'unknown' }, async () => {
      await taskCreateTool.execute({ title: 'first' });
    });
    await runWithSession({ id: 'bot:333', scope: 'unknown' }, async () => {
      await taskCreateTool.execute({ title: 'second' });
      const list = (await taskListTool.execute({})) as { output: string };
      expect(list.output).toMatch(/first/);
      expect(list.output).toMatch(/second/);
    });

    // Different session sees nothing.
    await runWithSession({ id: 'bot:444', scope: 'unknown' }, async () => {
      const list = (await taskListTool.execute({})) as { output: string };
      expect(list.output).toMatch(/\(no tasks\)/);
    });

    _resetTasksForTesting();
  });
});
