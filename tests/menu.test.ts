import { describe, expect, it } from 'vitest';

import { clampSelection, filterCommands } from '../src/repl/CommandMenu.tsx';

describe('CommandMenu filter', () => {
  it('returns nothing for non-slash input', () => {
    expect(filterCommands('hello')).toEqual([]);
    expect(filterCommands('')).toEqual([]);
  });

  it('returns the full command set for a bare slash', () => {
    const all = filterCommands('/');
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.find((c) => c.name === '/help')).toBeDefined();
    expect(all.find((c) => c.name === '/mcp')).toBeDefined();
  });

  it('filters by case-insensitive prefix on the name only', () => {
    const m = filterCommands('/M');
    const names = m.map((c) => c.name).sort();
    expect(names).toEqual(['/mcp', '/model'].sort());
  });

  it('narrows further as the user keeps typing', () => {
    const m = filterCommands('/mod');
    expect(m.map((c) => c.name)).toEqual(['/model']);
  });

  it('returns empty for a name that doesn’t exist', () => {
    expect(filterCommands('/banana')).toEqual([]);
  });

  it('locks to the named command once a space is typed (args region)', () => {
    const m = filterCommands('/help model');
    expect(m.map((c) => c.name)).toEqual(['/help']);
  });
});

describe('clampSelection', () => {
  it('clamps below zero and above length', () => {
    expect(clampSelection('/', -5)).toBe(0);
    const all = filterCommands('/');
    expect(clampSelection('/', 9999)).toBe(all.length - 1);
  });

  it('returns 0 when no matches', () => {
    expect(clampSelection('/zzzzz', 3)).toBe(0);
  });

  it('passes through valid indices unchanged', () => {
    expect(clampSelection('/m', 1)).toBe(1);
  });
});
