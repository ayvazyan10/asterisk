// The `/` picker. Filtering and clamping run on every keystroke, and the
// selection index is a position into the *filtered* list — so a filter that
// narrows without the index following it would run the wrong command.

import { describe, expect, it } from 'vitest';

import { COMMANDS } from '../src/commands/registry.ts';
import { CommandMenu, clampSelection, filterCommands } from '../src/repl/CommandMenu.tsx';
import { defined } from './helpers.ts';
import { flush, renderInk } from './repl-harness.ts';

describe('filterCommands — typing', () => {
  it('closes the menu the moment a space follows the slash', () => {
    // "/ " is not a command prefix; showing the whole registry there would be
    // noise over an ordinary message that happens to start with a slash.
    expect(filterCommands('/ ')).toEqual([]);
    expect(filterCommands('/ hello')).toEqual([]);
  });

  it('matches a full name typed in any case', () => {
    expect(filterCommands('/HELP').map((c) => c.name)).toEqual(['/help']);
    expect(filterCommands('/HeLp').map((c) => c.name)).toEqual(['/help']);
  });

  it('keeps the command locked once args are being typed', () => {
    expect(filterCommands('/help ').map((c) => c.name)).toEqual(['/help']);
    expect(filterCommands('/help some args here').map((c) => c.name)).toEqual(['/help']);
  });

  it('matches nothing when an unknown name already has args', () => {
    expect(filterCommands('/nope arg')).toEqual([]);
  });

  it('requires an exact name once a space is typed, not a prefix', () => {
    // "/mod x" must not resolve to /model — the user named a command that
    // does not exist, and silently running a near-match would be worse than
    // saying so.
    expect(filterCommands('/mod x')).toEqual([]);
  });

  it('makes every registered command reachable by its own name', () => {
    for (const cmd of COMMANDS) {
      const names = filterCommands(cmd.name).map((c) => c.name);
      expect(names).toContain(cmd.name);
    }
  });

  it('narrows monotonically as characters are added', () => {
    // Each extra character may only remove candidates. If it ever added one,
    // the highlighted row would jump under the user's fingers.
    for (const cmd of COMMANDS) {
      const name = cmd.name.slice(1);
      let previous = filterCommands('/').map((c) => c.name);
      for (let i = 1; i <= name.length; i++) {
        const current = filterCommands(`/${name.slice(0, i)}`).map((c) => c.name);
        for (const n of current) expect(previous).toContain(n);
        previous = current;
      }
    }
  });

  it('preserves registry order in the filtered list', () => {
    const all = COMMANDS.map((c) => c.name);
    const filtered = filterCommands('/s').map((c) => c.name);
    expect(filtered.length).toBeGreaterThan(0);
    const positions = filtered.map((n) => all.indexOf(n));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('ignores input that is not a command line at all', () => {
    expect(filterCommands('what is 2 + 2')).toEqual([]);
    expect(filterCommands(' /help')).toEqual([]);
  });
});

describe('clampSelection — keeping the highlight inside the list', () => {
  it('pulls the index back when the list shrinks under it', () => {
    const wide = filterCommands('/');
    const narrow = filterCommands('/mo');
    expect(narrow.length).toBeLessThan(wide.length);
    expect(clampSelection('/mo', wide.length - 1)).toBe(narrow.length - 1);
  });

  it('clamps to the only row for a single match', () => {
    expect(clampSelection('/help', 0)).toBe(0);
    expect(clampSelection('/help', 7)).toBe(0);
  });

  it('never returns an index the caller cannot dereference', () => {
    for (const input of ['/', '/m', '/s', '/help', '/zzz', 'no slash']) {
      const matches = filterCommands(input);
      for (const attempt of [-3, 0, 1, 5, 999]) {
        const idx = clampSelection(input, attempt);
        expect(idx).toBeGreaterThanOrEqual(0);
        if (matches.length > 0) expect(matches[idx]).toBeDefined();
      }
    }
  });
});

describe('CommandMenu rendering', () => {
  async function frameOf(input: string, selectedIndex: number): Promise<string> {
    const h = renderInk(<CommandMenu input={input} selectedIndex={selectedIndex} />);
    await flush();
    const frame = h.lastFrame();
    h.unmount();
    return frame;
  }

  it('renders nothing at all for ordinary text', async () => {
    expect((await frameOf('hello world', 0)).trim()).toBe('');
  });

  it('lists the matching commands with their descriptions', async () => {
    const frame = await frameOf('/mo', 0);
    const match = defined(filterCommands('/mo')[0], 'first /mo match');
    expect(frame).toContain(match.name);
    expect(frame).toContain(match.description.slice(0, 20));
  });

  it('marks exactly one row as selected', async () => {
    const frame = await frameOf('/', 3);
    expect(frame.split('›').length - 1).toBe(1);
  });

  it('moves the marker to the row the index names', async () => {
    const matches = filterCommands('/s');
    expect(matches.length).toBeGreaterThan(1);
    const second = defined(matches[1], 'second /s match');
    const frame = await frameOf('/s', 1);
    expect(frame).toContain(`› ${second.name}`);
  });

  it('shows the last row selected when the index overruns the list', async () => {
    const matches = filterCommands('/s');
    const last = defined(matches[matches.length - 1], 'last /s match');
    const frame = await frameOf('/s', 999);
    expect(frame).toContain(`› ${last.name}`);
  });

  it('recovers from a negative index instead of blanking', async () => {
    const first = defined(filterCommands('/s')[0], 'first /s match');
    expect(await frameOf('/s', -4)).toContain(`› ${first.name}`);
  });

  it('explains itself when nothing matches', async () => {
    const frame = await frameOf('/zzzznope', 0);
    expect(frame).toContain('no matching command');
    expect(frame).toContain('/help');
  });

  it('shows the usage hint of the selected command only', async () => {
    const withUsage = COMMANDS.find((c) => c.usage);
    if (!withUsage) return;
    const matches = filterCommands(withUsage.name);
    expect(matches.map((c) => c.name)).toContain(withUsage.name);
    const frame = await frameOf(withUsage.name, matches.indexOf(withUsage));
    expect(frame).toContain('usage:');
    expect(frame).toContain(defined(withUsage.usage, 'usage'));
  });

  it('always offers the navigation keys', async () => {
    const frame = await frameOf('/', 0);
    expect(frame).toContain('Tab complete');
    expect(frame).toContain('Enter run');
    expect(frame).toContain('Esc clear');
  });
});
