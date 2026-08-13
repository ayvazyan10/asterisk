import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { type AgentState, createAgentState } from '../src/agent/loop.ts';
import { BOT_COMMAND_LIST, tryHandleBotCommand } from '../src/bots/commands.ts';
import { loadConfig, saveConfig } from '../src/config/load.ts';
import { readSessionSoul } from '../src/soul/loader.ts';
import { isPlanMode, setPlanMode } from '../src/tools/planmode.ts';
import {
  _allTasks,
  _resetTasksForTesting,
  taskCreateTool,
  taskUpdateTool,
} from '../src/tools/tasks.ts';
import { enterWorktreeTool, exitWorktreeTool } from '../src/tools/worktree.ts';

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
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/help', ctx(state)));
    expect(r?.text).toMatch(/I'm Asterisk/);
    expect(r?.text).toMatch(/\/help/);
    expect(r?.text).toMatch(/\/status/);
  });

  it('/clear empties history', async () => {
    state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(state.history).toHaveLength(1);
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/clear', ctx(state)));
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
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/tasks', ctx(state)));
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
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/status', ctx(state)));
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
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/soul', ctx(state)));
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
    await runWithSession(SESSION, async () => tryHandleBotCommand(`/soul set ${body}`, ctx(state)));
    const stored = readSessionSoul(SESSION) ?? '';
    expect(stored).toContain('# Persona');
    expect(stored).toContain('- terse');
    expect(stored).toContain('no apologies');
  });

  it('/style with no args lists styles + marks the current one', async () => {
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/style', ctx(state)));
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

  it('/start greets with the same help text', async () => {
    // Telegram sends /start on the very first contact, before the user has
    // typed anything — it is the one command a new user is guaranteed to hit.
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/start', ctx(state)));
    expect(r?.text).toMatch(/I'm Asterisk/);
  });

  it('/status counts tasks by status and pluralises the history line', async () => {
    await runWithSession(SESSION, async () => {
      state.history.push(
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
      );
      for (const title of ['a', 'b', 'c', 'd']) await taskCreateTool.execute({ title });
      const ids = _allTasks().map((t) => t.id);
      await taskUpdateTool.execute({ id: ids[1], status: 'in_progress' });
      await taskUpdateTool.execute({ id: ids[2], status: 'completed' });
      await taskUpdateTool.execute({ id: ids[3], status: 'cancelled' });

      const r = tryHandleBotCommand('/status', ctx(state));
      expect(r?.text).toMatch(/History\s+2 messages/);
      expect(r?.text).toMatch(/Tasks\s+4 total · 1 in_progress · 1 done · 1 pending/);
    });
  });

  it('/status reports plan mode when it is on', async () => {
    await runWithSession(SESSION, async () => {
      setPlanMode(true);
      const r = tryHandleBotCommand('/status', ctx(state));
      expect(r?.text).toMatch(/Plan Mode\s+ON \(read-only\)/);
    });
  });

  it('/status names the anthropic model when anthropic is the provider', async () => {
    // The model line reads from a different config branch per provider, so a
    // provider switch is exactly where it can start reporting the wrong one.
    const cfg = loadConfig().config;
    saveConfig({
      ...cfg,
      provider: 'anthropic',
      anthropic: { ...cfg.anthropic, model: 'claude-sonnet-5' },
    });
    const r = await runWithSession(SESSION, async () => tryHandleBotCommand('/status', ctx(state)));
    expect(r?.text).toMatch(/Model\s+claude-sonnet-5/);
  });

  it('/status names the active worktree', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'asterisk-bot-wt-'));
    const cwd = process.cwd();
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    };
    try {
      git('init', '-b', 'master');
      writeFileSync(join(repo, 'a.txt'), 'x\n');
      git('add', '.');
      git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'first');
      process.chdir(repo);

      const status = await runWithSession(SESSION, async () => {
        await enterWorktreeTool.execute({ branch: 'wt-test', path: join(home, 'wt') });
        const r = tryHandleBotCommand('/status', ctx(state));
        // Drop it again inside the same session, or the module-level map
        // leaks an active worktree into every later test in this file.
        await exitWorktreeTool.execute({ force: true });
        return r;
      });

      expect(status?.text).toMatch(/Worktree\s+\S*wt \(branch wt-test\)/);
    } finally {
      process.chdir(cwd);
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('/tasks marks each status with its own glyph and appends descriptions', async () => {
    await runWithSession(SESSION, async () => {
      await taskCreateTool.execute({ title: 'pending one' });
      await taskCreateTool.execute({ title: 'running', description: 'half done' });
      await taskCreateTool.execute({ title: 'finished' });
      await taskCreateTool.execute({ title: 'dropped' });
      const ids = _allTasks().map((t) => t.id);
      await taskUpdateTool.execute({ id: ids[1], status: 'in_progress' });
      await taskUpdateTool.execute({ id: ids[2], status: 'completed' });
      await taskUpdateTool.execute({ id: ids[3], status: 'cancelled' });

      const text = tryHandleBotCommand('/tasks', ctx(state))?.text ?? '';
      expect(text).toMatch(/○ #\S+ {2}pending one/);
      expect(text).toMatch(/◐ #\S+ {2}running — half done/);
      expect(text).toMatch(/✓ #\S+ {2}finished/);
      expect(text).toMatch(/✗ #\S+ {2}dropped/);
    });
  });

  it('/soul set with no text explains itself instead of saving nothing', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul set', ctx(state)),
    );
    expect(r?.text).toMatch(/Usage: \/soul set/);
    expect(readSessionSoul(SESSION)).toBeNull();
  });

  it('/soul clear says so when there was nothing to clear', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul clear', ctx(state)),
    );
    expect(r?.text).toMatch(/nothing to clear/);
  });

  it('/soul edit points at /soul set when there is nothing to edit', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul edit', ctx(state)),
    );
    expect(r?.text).toMatch(/no personal soul yet/);
    expect(r?.text).toMatch(/\/soul set/);
  });

  it('/soul show is a synonym for a bare /soul', async () => {
    const r = await runWithSession(SESSION, async () => {
      tryHandleBotCommand('/soul set SHOWN PERSONA', ctx(state));
      return tryHandleBotCommand('/soul show', ctx(state));
    });
    expect(r?.text).toMatch(/SHOWN PERSONA/);
  });

  it('/soul with an unrecognised verb names it rather than guessing', async () => {
    const r = await runWithSession(SESSION, async () =>
      tryHandleBotCommand('/soul frobnicate', ctx(state)),
    );
    expect(r?.text).toMatch(/Unknown subcommand "frobnicate"/);
    expect(r?.text).toMatch(/\/soul help/);
  });

  it('labels every soul layer it loaded', async () => {
    // Three layers with three different labels; the point of showing them is
    // that a user can tell which one to change.
    const project = await mkdtemp(join(tmpdir(), 'asterisk-bot-soul-'));
    const cwd = process.cwd();
    try {
      writeFileSync(join(home, 'SOUL.md'), 'OPERATOR LAYER');
      writeFileSync(join(project, 'SOUL.md'), 'PROJECT LAYER');
      process.chdir(project);

      const r = await runWithSession(SESSION, async () => {
        tryHandleBotCommand('/soul set SESSION LAYER', ctx(state));
        return tryHandleBotCommand('/soul', ctx(state));
      });

      const text = r?.text ?? '';
      expect(text).toMatch(/operator soul/);
      expect(text).toMatch(/your soul/);
      expect(text).toMatch(/project soul/);
      expect(text).toContain('OPERATOR LAYER');
      expect(text).toContain('SESSION LAYER');
      expect(text).toContain('PROJECT LAYER');
    } finally {
      process.chdir(cwd);
      await rm(project, { recursive: true, force: true });
    }
  });

  it('truncates a soul too long to send back in one message', async () => {
    const r = await runWithSession(SESSION, async () => {
      tryHandleBotCommand(`/soul set ${'L'.repeat(1600)}`, ctx(state));
      return tryHandleBotCommand('/soul', ctx(state));
    });
    expect(r?.text).toContain('…(truncated)');
    // A maximal run of exactly 1500, not a count of every L in the message.
    // The reply prints the soul's path above its body, and that path is the
    // mkdtemp directory from beforeEach — whose random suffix contains an L
    // often enough to have made this test fail about one run in three.
    expect(r?.text).toMatch(/(?<!L)L{1500}(?!L)/);
  });

  it('command list is non-empty and well-formed', () => {
    expect(BOT_COMMAND_LIST.length).toBeGreaterThanOrEqual(7);
    for (const c of BOT_COMMAND_LIST) {
      expect(c.command).toMatch(/^[a-z]+$/);
      expect(c.description.length).toBeGreaterThan(5);
    }
  });
});
