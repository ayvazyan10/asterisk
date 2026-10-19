import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import type { Handler, IncomingMessage } from '../src/bots/adapter.ts';
import type { ImageIntakeResult } from '../src/bots/image-intake.ts';
import type { VoiceIntakeResult } from '../src/bots/voice-intake.ts';
import { logs, start, status, stop } from '../src/daemon/lifecycle.ts';
import { asteriskPaths } from '../src/daemon/paths.ts';
import { statusFromPidFile } from '../src/daemon/pidfile.ts';
import { closeDb } from '../src/db/index.ts';

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
  });

  afterEach(async () => {
    await stop().catch(() => {});
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    if (prevHeartbeat === undefined) delete process.env['ASTERISK_HEARTBEAT_MS'];
    else process.env['ASTERISK_HEARTBEAT_MS'] = prevHeartbeat;
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
});

describe('daemon intake interruption', () => {
  let home: string;
  let handler: Handler;
  let state = createAgentState();
  const voice = vi.fn<(msg: IncomingMessage) => Promise<VoiceIntakeResult>>();
  const image = vi.fn<(msg: IncomingMessage) => Promise<ImageIntakeResult>>();
  const runTurn = vi.fn(runAgentTurn);
  const save = vi.fn();
  const command = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), 'asterisk-daemon-intake-'));
    vi.stubEnv('ASTERISK_HOME', home);
    state = createAgentState();
    state.history = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }];
    voice.mockImplementation(async (msg) => ({ text: msg.text }));
    image.mockImplementation(async (msg) => ({ kind: 'accepted', text: msg.text, images: [] }));
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
    vi.doMock('../src/bots/manager.ts', () => ({
      createBotManager: () => ({
        start: async (next: Handler) => {
          handler = next;
          return [];
        },
        cancelApprovals: () => 0,
      }),
    }));
    await importDaemon();
  });

  async function importDaemon(): Promise<void> {
    vi.doMock('../src/bots/approval-bridge.ts', () => ({ attachChatApprovals: () => () => {} }));
    vi.doMock('../src/providers/factory.ts', () => ({
      chooseProvider: () => ({ provider: { name: 'fake' } }),
    }));
    vi.doMock('../src/mcp/manager.ts', () => ({
      createMcpManager: () => ({ tools: [], reload: async () => ({ connected: [], failed: [] }) }),
    }));
    vi.doMock('../src/daemon/scheduler.ts', () => ({
      createScheduler: () => ({ start: () => {} }),
    }));
    vi.doMock('../src/daemon/logger.ts', () => ({
      createDaemonLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
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
    vi.doUnmock('../src/bots/manager.ts');
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
