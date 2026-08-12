// Minimal Ink test harness. Not a test file — vitest only collects *.test.ts.
//
// `ink-testing-library` does exactly this job, but it is a whole dependency to
// own for ~60 lines of fake streams, and the streams are the only part that is
// not already public Ink API. Everything below is written against Ink's
// documented `RenderOptions` ({stdout, stdin, debug, exitOnCtrlC,
// patchConsole}) — no Ink internals are touched.
//
// `debug: true` makes Ink write each complete frame to stdout instead of
// diffing against the previous one through ansi-escapes, so `lastFrame()` is
// the whole current screen rather than a cursor-movement soup.

import { EventEmitter } from 'node:events';

import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';

/** Key sequences a terminal would send. */
export const KEY = {
  up: '\u001B[A',
  down: '\u001B[B',
  left: '\u001B[D',
  right: '\u001B[C',
  enter: '\r',
  escape: '\u001B',
  tab: '\t',
  shiftTab: '\u001B[Z',
  ctrlO: '\u000F',
  ctrlS: '\u0013',
} as const;

// Built at runtime rather than written as a literal so the source carries no
// raw control characters.
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${ESC}]*${ESC}\\\\`, 'g');

/** Drop ANSI colour/cursor codes so assertions read like the visible screen. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  columns = 100;
  rows = 40;
  isTTY = true;

  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };

  /**
   * Ink also writes bare cursor-hide/show sequences through stdout (cli-cursor
   * does this when raw mode is toggled). Those are not frames, and taking the
   * literal last write would hand the caller `ESC[?25l` instead of the screen.
   */
  lastContentFrame(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i] ?? '';
      if (stripAnsi(frame).trim() !== '') return frame;
    }
    return this.frames[this.frames.length - 1] ?? '';
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  encoding: string | undefined;
  private readonly queue: string[] = [];

  /**
   * Ink 5 pulls input with the `readable` event + `read()` rather than
   * listening for `data`, so a fake stdin has to behave like a paused stream:
   * queue the chunk, announce it, hand it over once.
   */
  send(data: string): void {
    this.queue.push(data);
    this.emit('readable');
  }

  setEncoding(encoding: string): this {
    this.encoding = encoding;
    return this;
  }

  setRawMode(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  read(): string | null {
    return this.queue.shift() ?? null;
  }
}

export interface Harness {
  /** The most recent complete frame Ink painted. */
  lastFrame(): string;
  /** Every frame painted so far, oldest first. */
  frames(): readonly string[];
  /** Send a key or a run of characters, as a terminal would. */
  write(data: string): void;
  rerender(node: ReactElement): void;
  unmount(): void;
}

/**
 * Mount an Ink element against fake streams.
 *
 * Ink renders asynchronously, so callers must `await flush()` (or
 * `await writeAndFlush`) before asserting on a frame.
 */
export function renderInk(node: ReactElement): Harness {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = inkRender(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    lastFrame: () => stripAnsi(stdout.lastContentFrame()),
    frames: () => stdout.frames,
    write: (data: string) => {
      stdin.send(data);
    },
    rerender: (next: ReactElement) => instance.rerender(next),
    unmount: () => instance.unmount(),
  };
}

/** Let React/Ink flush pending state updates and repaint. */
export async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Send input and wait for the resulting frame.
 *
 * Flushes first as well as after: Ink paints in a commit hook but subscribes
 * `useInput` handlers in a passive effect, so a component can be on screen a
 * tick before it is listening. Writing without that leading flush drops the
 * keystroke on the floor — silently, since there is nobody to receive it.
 */
export async function press(harness: Harness, key: string): Promise<void> {
  await flush();
  harness.write(key);
  await flush();
}

/**
 * Poll until `predicate` holds, then return. Used instead of a fixed sleep so
 * a slow turn does not become a flaky test — and so a broken one fails with
 * the frame that was actually on screen.
 */
export async function waitFor(
  harness: Harness,
  predicate: (frame: string) => boolean,
  what = 'condition',
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(harness.lastFrame())) return;
    await flush(1);
  }
  throw new Error(`timed out waiting for ${what}. Last frame:\n${harness.lastFrame()}`);
}

/** Poll until an arbitrary condition holds (e.g. a promise's side effect). */
export async function waitUntil(
  predicate: () => boolean,
  what = 'condition',
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}
