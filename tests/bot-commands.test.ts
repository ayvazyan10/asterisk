import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { type AgentState, createAgentState } from '../src/agent/loop.ts';
import { BOT_COMMAND_LIST, tryHandleBotCommand } from '../src/bots/commands.ts';
import { _resetTasksForTesting, taskCreateTool } from '../src/tools/tasks.ts';
import { isPlanMode, setPlanMode } from '../src/tools/planmode.ts';

function ctx(state: AgentState) {
  return { state, providerName: 'ollama:test' };
}

const SESSION = { id: 'bot:test', scope: 'unknown' as const };

describe('bot commands', () => {
  let state: AgentState;

  beforeEach(() => {
    state = createAgentState();
    _resetTasksForTesting();
  });

  afterEach(() => {
    _resetTasksForTesting();
  });

  it('falls through (returns null) for non-slash messages', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('hello there', ctx(state)),
    );
    expect(r).toBeNull();
  });

  it('falls through for unknown slash commands', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/notreal', ctx(state)),
    );
    expect(r).toBeNull();
  });

  it('/help returns the help text', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/help', ctx(state)),
    );
    expect(r?.text).toMatch(/I'm Asterisk/);
    expect(r?.text).toMatch(/\/help/);
    expect(r?.text).toMatch(/\/status/);
  });

  it('/clear empties history', async () => {
    state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(state.history).toHaveLength(1);
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/clear', ctx(state)),
    );
    expect(r?.text).toMatch(/cleared/);
    expect(state.history).toHaveLength(0);
  });

  it('/reset clears history + tasks + plan mode', async () => {
    await runWithSession(SESSION, async () => {
      state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
      await taskCreateTool.execute({ title: 'todo' });
      setPlanMode(true);
      const r = tryHandleBotCommand('/reset', ctx(state));
      expect(r?.text).toMatch(/reset/);
      expect(state.history).toHaveLength(0);
      expect(isPlanMode()).toBe(false);
    });
  });

  it('/tasks lists tasks for the current session', async () => {
    await runWithSession(SESSION, async () => {
      await taskCreateTool.execute({ title: 'walk the dog' });
      const r = tryHandleBotCommand('/tasks', ctx(state));
      expect(r?.text).toMatch(/walk the dog/);
    });
  });

  it('/tasks reports an empty state cleanly', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/tasks', ctx(state)),
    );
    expect(r?.text).toMatch(/no tasks/);
  });

  it('/plan toggles Plan Mode within the session', async () => {
    await runWithSession(SESSION, async () => {
      expect(isPlanMode()).toBe(false);
      tryHandleBotCommand('/plan', ctx(state));
      expect(isPlanMode()).toBe(true);
      tryHandleBotCommand('/plan', ctx(state));
      expect(isPlanMode()).toBe(false);
    });
  });

  it('/status surfaces session, history, and plan-mode info', async () => {
    state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/status', ctx(state)),
    );
    expect(r?.text).toMatch(/Session\s+bot:test/);
    expect(r?.text).toMatch(/Provider\s+ollama:test/);
    expect(r?.text).toMatch(/History\s+1 message/);
    expect(r?.text).toMatch(/Plan Mode\s+off/);
  });

  it('/help@botname (group-chat suffix) is recognised', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/help@asterisk_bot', ctx(state)),
    );
    expect(r?.text).toMatch(/I'm Asterisk/);
  });

  it('command list is non-empty and well-formed', () => {
    expect(BOT_COMMAND_LIST.length).toBeGreaterThanOrEqual(7);
    for (const c of BOT_COMMAND_LIST) {
      expect(c.command).toMatch(/^[a-z]+$/);
      expect(c.description.length).toBeGreaterThan(5);
    }
  });
});
