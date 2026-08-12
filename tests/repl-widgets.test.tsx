// Banner, StatusBar and WorkingIndicator — the three things on screen during
// every single turn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Banner } from '../src/repl/Banner.tsx';
import { StatusBar } from '../src/repl/StatusBar.tsx';
import { WorkingIndicator } from '../src/repl/WorkingIndicator.tsx';
import { flush, renderInk } from './repl-harness.ts';

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env['HOME'];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  vi.restoreAllMocks();
});

async function frameOf(node: React.ReactElement): Promise<string> {
  const h = renderInk(node);
  await flush();
  const frame = h.lastFrame();
  h.unmount();
  return frame;
}

describe('StatusBar', () => {
  it('distinguishes idle from working', async () => {
    const idle = await frameOf(
      <StatusBar providerName="ollama" historyCount={0} cwd="/srv" busy={false} />,
    );
    expect(idle).toContain('ready');
    expect(idle).not.toContain('working');

    const busy = await frameOf(
      <StatusBar providerName="ollama" historyCount={0} cwd="/srv" busy={true} />,
    );
    expect(busy).toContain('working');
    expect(busy).not.toContain('ready');
  });

  it('reports the provider and the message count', async () => {
    const frame = await frameOf(
      <StatusBar providerName="anthropic" historyCount={12} cwd="/srv" busy={false} />,
    );
    expect(frame).toContain('anthropic');
    expect(frame).toContain('12 msgs');
  });

  it('abbreviates the home directory', async () => {
    process.env['HOME'] = '/home/dev';
    const frame = await frameOf(
      <StatusBar providerName="ollama" historyCount={0} cwd="/home/dev/projects/x" busy={false} />,
    );
    expect(frame).toContain('~/projects/x');
    expect(frame).not.toContain('/home/dev/projects');
  });

  it('leaves paths outside home alone', async () => {
    process.env['HOME'] = '/home/dev';
    const frame = await frameOf(
      <StatusBar providerName="ollama" historyCount={0} cwd="/var/tmp" busy={false} />,
    );
    expect(frame).toContain('/var/tmp');
  });

  it('survives an unset HOME', async () => {
    delete process.env['HOME'];
    const frame = await frameOf(
      <StatusBar providerName="ollama" historyCount={0} cwd="/var/tmp" busy={false} />,
    );
    expect(frame).toContain('/var/tmp');
  });
});

describe('Banner', () => {
  it('shows the product, version, provider and directory', async () => {
    process.env['HOME'] = '/home/dev';
    const frame = await frameOf(
      <Banner providerName="ollama" cwd="/home/dev/code" version="9.9.9" />,
    );
    expect(frame).toContain('Asterisk');
    expect(frame).toContain('v9.9.9');
    expect(frame).toContain('ollama');
    expect(frame).toContain('~/code');
  });

  it('points at the help command', async () => {
    const frame = await frameOf(<Banner providerName="ollama" cwd="/x" version="1.0.0" />);
    expect(frame).toContain('/help');
    expect(frame).toContain('/quit');
  });
});

describe('WorkingIndicator', () => {
  it('shows the current status and how to stop', async () => {
    const frame = await frameOf(<WorkingIndicator since={Date.now()} status="Bash(ls)" />);
    expect(frame).toContain('Bash(ls)');
    expect(frame).toContain('ESC to cancel');
  });

  it('counts seconds below a minute', async () => {
    const frame = await frameOf(<WorkingIndicator since={Date.now() - 7_000} status="thinking" />);
    expect(frame).toContain('7s');
    expect(frame).not.toContain('m ');
  });

  it('switches to minutes and pads the seconds', async () => {
    const frame = await frameOf(<WorkingIndicator since={Date.now() - 65_000} status="thinking" />);
    expect(frame).toContain('1m 05s');
  });

  it('never shows a negative elapsed time for a clock skew', async () => {
    const frame = await frameOf(<WorkingIndicator since={Date.now() + 10_000} status="thinking" />);
    expect(frame).toContain('0s');
    expect(frame).not.toContain('-');
  });

  it('falls back to a verb when the status goes quiet', async () => {
    // A model that spends a minute generating tool calls emits no events. A
    // frozen "thinking" reads as a hang, so after five seconds the indicator
    // switches to a self-evidently live phrase.
    const start = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const h = renderInk(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    expect(h.lastFrame()).toContain('thinking');

    now.mockReturnValue(start + 6_000);
    h.rerender(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    const frame = h.lastFrame();
    expect(frame).not.toContain('thinking');
    expect(frame).toMatch(/[A-Z][a-z]+…/);
    h.unmount();
  });

  it('keeps the same verb for the same turn', async () => {
    const start = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const h = renderInk(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    now.mockReturnValue(start + 6_000);
    h.rerender(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    const first = h.lastFrame().match(/([A-Z][a-z]+)…/)?.[1];
    now.mockReturnValue(start + 7_000);
    h.rerender(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    expect(h.lastFrame().match(/([A-Z][a-z]+)…/)?.[1]).toBe(first);
    h.unmount();
  });

  it('varies the verb between turns', async () => {
    // Derived from `since` rather than drawn at random, so it is stable
    // within a turn and still changes turn to turn.
    const verbFor = async (since: number): Promise<string | undefined> => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(since);
      const h = renderInk(<WorkingIndicator since={since} status="thinking" />);
      await flush();
      now.mockReturnValue(since + 6_000);
      h.rerender(<WorkingIndicator since={since} status="thinking" />);
      await flush();
      const verb = h.lastFrame().match(/([A-Z][a-z]+)…/)?.[1];
      h.unmount();
      now.mockRestore();
      return verb;
    };
    expect(await verbFor(1_000_000)).not.toBe(await verbFor(1_001_000));
  });

  it('goes back to a live status when one arrives', async () => {
    const start = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    const h = renderInk(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    now.mockReturnValue(start + 6_000);
    h.rerender(<WorkingIndicator since={start} status="thinking" />);
    await flush();
    expect(h.lastFrame()).not.toContain('thinking');

    h.rerender(<WorkingIndicator since={start} status="Read(x)" />);
    await flush();
    expect(h.lastFrame()).toContain('Read(x)');
    h.unmount();
  });
});
