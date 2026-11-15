import * as childProcess from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import type { BotAdapter, Handler, IncomingMessage } from '../src/bots/adapter.ts';
import type { ImageIntakeResult } from '../src/bots/image-intake.ts';
import type { VoiceIntakeResult } from '../src/bots/voice-intake.ts';
import { logs, start, status, stop } from '../src/daemon/lifecycle.ts';
import { asteriskPaths } from '../src/daemon/paths.ts';
import { statusFromPidFile } from '../src/daemon/pidfile.ts';
import { PROJECT_ROOT, entrypointPath } from '../src/daemon/project-root.ts';
import type { SchedulerOptions } from '../src/daemon/scheduler.ts';
import { closeDb } from '../src/db/index.ts';

vi.mock('node:os', { spy: true });
vi.mock('node:child_process', { spy: true });

describe('daemon lifecycle', () => {
  let home: string;
  let prevHome: string | undefined;
  let prevHeartbeat: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-daemon-'));
    prevHome = process.env['ASTERISK_HOME'];
    prevHeartbeat = process.env['ASTERISK_HEARTBEAT_MS'];
    process.env['ASTERISK_HOME'] = home;
    // Fast heartbeat so the test exercises the logger path quickly.
    process.env['ASTERISK_HEARTBEAT_MS'] = '200';
    vi.stubEnv('ASTERISK_WORKSPACE', join(home, 'workspace'));
    vi.stubEnv('ASTERISK_ENTRY_FROM_SOURCE', '1');
  });

  afterEach(async () => {
    await stop().catch(() => {});
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    if (prevHeartbeat === undefined) delete process.env['ASTERISK_HEARTBEAT_MS'];
    else process.env['ASTERISK_HEARTBEAT_MS'] = prevHeartbeat;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it('start writes a pid file, status reports running, stop clears it', async () => {
    const startRes = await start();
    expect(startRes.ok).toBe(true);

    const paths = asteriskPaths();
    const s = statusFromPidFile(paths.pidFile);
    expect(s.running).toBe(true);
    expect(s.pid).toBeGreaterThan(0);

    const statusRes = status();
    expect(statusRes.message).toMatch(/running \(pid \d+\)/);

    // Poll for the first log line instead of sleeping a fixed 500ms. The fixed
    // wait passed in isolation and failed under a loaded parallel run, because
    // it raced a real spawned `bun` process writing its first line — the suite's
    // only genuinely flaky assertion.
    const deadline = Date.now() + 10_000;
    let tail = logs(20);
    while (!/heartbeat|asterisk daemon starting/.test(tail.message) && Date.now() < deadline) {
      await delay(50);
      tail = logs(20);
    }
    expect(tail.message).toMatch(/heartbeat|asterisk daemon starting/);

    const stopRes = await stop();
    expect(stopRes.ok).toBe(true);
    const after = statusFromPidFile(paths.pidFile);
    expect(after.running).toBe(false);
  }, 15_000);

  it('refuses to double-start', async () => {
    const first = await start();
    expect(first.ok).toBe(true);
    const second = await start();
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already running/);
    await stop();
  }, 15_000);

  it('reports not-running cleanly when no daemon was started', () => {
    const s = status();
    expect(s.message).toBe('not running');
  });

  it.each(['unset', 'empty', 'whitespace', 'absolute', 'relative'] as const)(
    'spawns in an owner-only workspace with an absolute entrypoint (%s override)',
    async (kind) => {
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      const workspace = join(
        home,
        kind === 'absolute' || kind === 'relative' ? 'custom-workspace' : 'asterisk-workspace',
      );
      const overrides = {
        unset: undefined,
        empty: '',
        whitespace: ' \t ',
        absolute: workspace,
        relative: relative(process.cwd(), workspace),
      };
      vi.stubEnv('ASTERISK_WORKSPACE', overrides[kind]);
      const spawn = vi.spyOn(childProcess, 'spawn');

      const result = await start();
      expect(result.ok, result.message).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        'bun',
        [entrypointPath('daemon')],
        expect.objectContaining({
          cwd: workspace,
          env: expect.objectContaining({ ASTERISK_WORKSPACE: workspace, ASTERISK_DAEMON: '1' }),
        }),
      );
      expect(isAbsolute(entrypointPath('daemon'))).toBe(true);
      expect(workspace).not.toBe(PROJECT_ROOT);
      expect(statSync(workspace).isDirectory()).toBe(true);
      expect(statSync(workspace).mode & 0o777).toBe(0o700);
    },
    15_000,
  );
});

describe('daemon dispatch', () => {
  let home: string;
  let handler: Handler;
  let state = createAgentState();
  const voice = vi.fn<(msg: IncomingMessage) => Promise<VoiceIntakeResult>>();
  const image = vi.fn<(msg: IncomingMessage) => Promise<ImageIntakeResult>>();
  const runTurn = vi.fn(runAgentTurn);
  const save = vi.fn();
  const command = vi.fn();
  const send = vi.fn<BotAdapter['sendMessage']>();
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  let dispatch: SchedulerOptions['dispatch'];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), 'asterisk-daemon-intake-'));
    vi.stubEnv('ASTERISK_HOME', home);
    vi.stubEnv('ASTERISK_TELEGRAM_BOT_TOKEN', 'fake');
    const { loadConfig, saveConfig } = await import('../src/config/load.ts');
    const { config } = loadConfig();
    config.bots.telegram.enabled = true;
    saveConfig(config);
    state = createAgentState();
    state.history = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }];
    voice.mockImplementation(async (msg) => ({ text: msg.text }));
    image.mockImplementation(async (msg) => ({ kind: 'accepted', text: msg.text, images: [] }));
    runTurn.mockResolvedValue({ finalText: 'reminder result', reason: 'end-turn' });
    send.mockReset().mockResolvedValue(undefined);
    vi.doMock('../src/agent/loop.ts', () => ({
      createAgentState: () => state,
      runAgentTurn: runTurn,
    }));
    vi.doMock('../src/agent/persistence.ts', () => ({
      loadConversation: () => [],
      saveConversation: save,
    }));
    vi.doMock('../src/bots/voice-intake.ts', () => ({ intakeVoice: voice }));
    vi.doMock('../src/bots/image-intake.ts', async (original) => ({
      ...(await original<typeof import('../src/bots/image-intake.ts')>()),
      intakeImage: image,
    }));
    vi.doMock('../src/bots/commands.ts', async (original) => ({
      ...(await original<typeof import('../src/bots/commands.ts')>()),
      tryHandleBotCommand: command,
    }));
    vi.doMock('../src/bots/telegram/index.ts', () => ({
      createTelegramAdapter: (): BotAdapter => ({
        name: 'telegram',
        start: async (next: Handler) => {
          handler = next;
        },
        stop: async () => {},
        sendMessage: send,
        cancelApprovals: () => 0,
      }),
    }));
    await importDaemon();
  });

  async function importDaemon(): Promise<void> {
    vi.doMock('../src/bots/approval-bridge.ts', () => ({ attachChatApprovals: () => () => {} }));
    vi.doMock('../src/providers/factory.ts', () => ({
      createProviderChain: () => ({ provider: { name: 'fake' } }),
    }));
    vi.doMock('../src/mcp/manager.ts', () => ({
      createMcpManager: () => ({ tools: [], reload: async () => ({ connected: [], failed: [] }) }),
    }));
    vi.doMock('../src/daemon/scheduler.ts', () => ({
      createScheduler: (opts: SchedulerOptions) => {
        dispatch = opts.dispatch;
        return { start: () => {} };
      },
    }));
    vi.doMock('../src/daemon/logger.ts', () => ({
      createDaemonLogger: () => log,
    }));
    // Import the actual dispatcher without installing process handlers or leaving timers alive.
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    vi.useFakeTimers();
    try {
      await import('../src/entrypoints/daemon.ts');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      on.mockRestore();
    }
  }

  afterEach(async () => {
    vi.doUnmock('../src/agent/loop.ts');
    vi.doUnmock('../src/agent/persistence.ts');
    vi.doUnmock('../src/bots/voice-intake.ts');
    vi.doUnmock('../src/bots/image-intake.ts');
    vi.doUnmock('../src/bots/commands.ts');
    vi.doUnmock('../src/bots/telegram/index.ts');
    vi.doUnmock('../src/bots/approval-bridge.ts');
    vi.doUnmock('../src/providers/factory.ts');
    vi.doUnmock('../src/mcp/manager.ts');
    vi.doUnmock('../src/daemon/scheduler.ts');
    vi.doUnmock('../src/daemon/logger.ts');
    const db = await import('../src/db/index.ts');
    db.closeDb();
    closeDb();
    vi.resetModules();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function message(text: string): IncomingMessage {
    return { chatId: 'chat', userId: '7', text, timestamp: Date.now() };
  }

  function gate(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('delivers the full scheduled result once to its origin and keeps the scheduled session', async () => {
    const finalText = 'A reminder with **formatting**. '.repeat(20);
    runTurn.mockResolvedValueOnce({ finalText, reason: 'end-turn' });
    await dispatch('remind me', 'oneshot:reminder', { transport: 'telegram', chatId: '42' });
    expect(send).toHaveBeenCalledExactlyOnceWith('42', finalText);
    expect(runTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'remind me',
      expect.objectContaining({
        session: { id: 'scheduled:oneshot:reminder', scope: 'scheduled' },
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      { source: 'oneshot:reminder', reason: 'end-turn', finalText: finalText.slice(0, 200) },
      'scheduled run finished',
    );
  });

  it('keeps a scheduled result without an origin in the log', async () => {
    await dispatch('local job', 'cron:local');
    expect(send).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { source: 'cron:local', reason: 'end-turn', finalText: 'reminder result' },
      'scheduled run finished',
    );
  });

  it('warns without throwing when the origin transport is not running', async () => {
    await expect(
      dispatch('remind me', 'oneshot:offline', { transport: 'offline', chatId: '42' }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      {
        source: 'oneshot:offline',
        transport: 'offline',
        chatId: '42',
        err: expect.objectContaining({ message: 'offline transport is not running' }),
      },
      'scheduled delivery failed',
    );
  });

  it('sends a short failure note when a scheduled turn throws', async () => {
    runTurn.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(
      dispatch('remind me', 'oneshot:failed', { transport: 'telegram', chatId: '42' }),
    ).rejects.toThrow('provider unavailable');
    expect(send).toHaveBeenCalledExactlyOnceWith('42', 'Scheduled run failed. Please try again.');
  });

  it('includes a failure note when the turn returns an error reason', async () => {
    runTurn.mockResolvedValueOnce({ finalText: 'Partial result', reason: 'auth-error' });
    await dispatch('remind me', 'cron:failed', { transport: 'telegram', chatId: '42' });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      '42',
      'Partial result\n\nScheduled run failed (auth-error).',
    );
  });

  it('logs an adapter send failure without throwing and keeps ticking', async () => {
    const { createScheduler } = await vi.importActual<typeof import('../src/daemon/scheduler.ts')>(
      '../src/daemon/scheduler.ts',
    );
    const { writeOneShots } = await import('../src/tools/schedule.ts');
    const origin = { transport: 'telegram', chatId: '42' };
    const err = new Error('adapter send failed');
    send.mockRejectedValueOnce(err);
    const events = vi.fn();
    const scheduler = createScheduler({ dispatch, log: events });
    vi.useFakeTimers();
    try {
      writeOneShots([{ id: 'first', prompt: 'first', fireAt: 1, createdAt: 1, origin }]);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send).toHaveBeenCalledExactlyOnceWith('42', 'reminder result');
      expect(log.warn).toHaveBeenCalledWith(
        { source: 'oneshot:first', ...origin, err },
        'scheduled delivery failed',
      );
      expect(log.info).toHaveBeenCalledWith(
        { source: 'oneshot:first', reason: 'end-turn', finalText: 'reminder result' },
        'scheduled run finished',
      );
      expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'oneshot_error' }));

      writeOneShots([{ id: 'next', prompt: 'next', fireAt: 1, createdAt: 1, origin }]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send.mock.calls).toEqual([
        ['42', 'reminder result'],
        ['42', 'reminder result'],
      ]);
    } finally {
      scheduler.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['voice', 'image'] as const)(
    'keeps history unchanged after /stop during %s intake',
    async (kind) => {
      const entered = gate();
      const release = gate();
      const blocked = async (msg: IncomingMessage) => {
        entered.resolve();
        await release.promise;
        return { kind: 'accepted' as const, text: msg.text, images: [] };
      };
      (kind === 'voice' ? voice : image).mockImplementationOnce(blocked);
      const path = join(home, kind);
      await writeFile(path, 'incoming attachment');
      const history = structuredClone(state.history);
      const sink = vi.fn();
      const running = handler({ ...message('stopped input'), [kind]: { path } }, { sink });
      await entered.promise;
      try {
        await expect(handler(message('/stop'))).resolves.toEqual({
          text: '⏹ stopped the running turn.',
        });
      } finally {
        release.resolve();
        await running;
      }
      await expect(running).resolves.toEqual({ text: '' });
      expect(state.history).toEqual(history);
      expect(runTurn).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(sink).toHaveBeenLastCalledWith({ type: 'final' });
      expect(existsSync(path)).toBe(false);
    },
  );

  it('deletes a queued voice recording dropped as stale without transcribing it', async () => {
    const entered = gate();
    const release = gate();
    image.mockImplementationOnce(async (msg) => {
      entered.resolve();
      await release.promise;
      return { kind: 'accepted', text: msg.text, images: [] };
    });
    const path = join(home, 'queued.oga');
    await writeFile(path, 'recording');
    const running = handler(message('first'));
    await entered.promise;
    const queued = handler({ ...message('queued'), voice: { path } });
    try {
      await expect(handler(message('/stop'))).resolves.toEqual({
        text: '⏹ stopped the running turn · dropped 1 queued message.',
      });
    } finally {
      release.resolve();
      await running;
      await queued;
    }
    await expect(queued).resolves.toEqual({ text: '' });
    expect(voice).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  });
});
