import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { type AgentState, createAgentState } from '../src/agent/loop.ts';
import { BOT_COMMAND_LIST, tryHandleBotCommand } from '../src/bots/commands.ts';
import { readSessionSoul } from '../src/soul/loader.ts';
import { _resetTasksForTesting, taskCreateTool } from '../src/tools/tasks.ts';
import { isPlanMode, setPlanMode } from '../src/tools/planmode.ts';

function ctx(state: AgentState) {
  return { state, providerName: 'ollama:test' };
}

const SESSION = { id: 'bot:test', scope: 'unknown' as const };

describe('bot commands', () => {
  let state: AgentState;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    state = createAgentState();
    _resetTasksForTesting();
    // Per-session soul writes land under ASTERISK_HOME/souls — sandbox so
    // the test never touches the real ~/.asterisk.
    home = await mkdtemp(join(tmpdir(), 'asterisk-bot-cmd-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    _resetTasksForTesting();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
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

  it('/soul (no args) reports nothing loaded for a fresh session', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul', ctx(state)),
    );
    expect(r?.text).toMatch(/no soul/i);
    expect(r?.text).toMatch(/\/soul set/);
  });

  it('/soul set <text> persists the persona for this session', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul set Call me Levon. Reply in Russian.', ctx(state)),
    );
    expect(r?.text).toMatch(/saved your soul/);
    expect(readSessionSoul(SESSION)).toMatch(/Call me Levon/);

    // A subsequent /soul (no args) now shows it back.
    const show = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul', ctx(state)),
    );
    expect(show?.text).toMatch(/Call me Levon/);
    expect(show?.text).toMatch(/your soul/);
  });

  it('/soul set is private to a session — another chat does not see it', async () => {
    await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul set ALICE PERSONA', ctx(state)),
    );
    const other = { id: 'bot:other', scope: 'unknown' as const };
    const r = await runWithSession(other, async () =>
      tryHandleBotCommand('/soul', ctx(createAgentState())),
    );
    expect(r?.text).not.toMatch(/ALICE PERSONA/);
    expect(r?.text).toMatch(/no soul/i);
  });

  it('/soul clear removes the personal soul', async () => {
    await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul set temp persona', ctx(state)),
    );
    expect(readSessionSoul(SESSION)).toMatch(/temp persona/);
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul clear', ctx(state)),
    );
    expect(r?.text).toMatch(/removed/);
    expect(readSessionSoul(SESSION)).toBeNull();
  });

  it('/soul edit prints the current soul for copy-tweak', async () => {
    await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul set EDIT_TARGET', ctx(state)),
    );
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul edit', ctx(state)),
    );
    expect(r?.text).toMatch(/EDIT_TARGET/);
  });

  it('/soul help describes the verbs', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul help', ctx(state)),
    );
    expect(r?.text).toMatch(/\/soul set/);
    expect(r?.text).toMatch(/\/soul clear/);
    expect(r?.text).toMatch(/\/soul edit/);
  });

  it('/soul set with multi-line markdown survives intact', async () => {
    const body = '# Persona\n\n- terse\n- direct\n- no apologies';
    await runWithSession(SESSION, async () =>
      tryHandleBotCommand(`/soul set ${body}`, ctx(state)),
    );
    const stored = readSessionSoul(SESSION) ?? '';
    expect(stored).toContain('# Persona');
    expect(stored).toContain('- terse');
    expect(stored).toContain('no apologies');
  });

  it('/style with no args lists styles + marks the current one', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/style', ctx(state)),
    );
    expect(r?.text).toMatch(/Current output style/);
    expect(r?.text).toMatch(/concise/);
    expect(r?.text).toMatch(/explanatory/);
    expect(r?.text).toMatch(/learning/);
  });

  it('/style <name> persists to config', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/style explanatory', ctx(state)),
    );
    expect(r?.text).toMatch(/✓ output style set to "explanatory"/);
    // Re-reading config should show the persisted value.
    const { loadConfig } = await import('../src/config/load.ts');
    expect(loadConfig().config.outputStyle).toBe('explanatory');
  });

  it('/style <bad> rejects with the valid options', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/style nonsense', ctx(state)),
    );
    expect(r?.text).toMatch(/unknown style/);
    expect(r?.text).toMatch(/default/);
    expect(r?.text).toMatch(/concise/);
  });

  it('command list is non-empty and well-formed', () => {
    expect(BOT_COMMAND_LIST.length).toBeGreaterThanOrEqual(7);
    for (const c of BOT_COMMAND_LIST) {
      expect(c.command).toMatch(/^[a-z]+$/);
      expect(c.description.length).toBeGreaterThan(5);
    }
  });
});
