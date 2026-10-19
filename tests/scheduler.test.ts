import { describe, expect, it } from 'vitest';

import { cronMatches, expandCronField } from '../src/daemon/scheduler.ts';

describe('expandCronField', () => {
  it('handles "*"', () => {
    const s = expandCronField('*', 0, 5);
    expect([...s]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles a single value', () => {
    expect([...expandCronField('3', 0, 10)]).toEqual([3]);
  });

  it('handles "a-b" ranges', () => {
    expect([...expandCronField('1-4', 0, 10)]).toEqual([1, 2, 3, 4]);
  });

  it('handles comma lists', () => {
    expect([...expandCronField('1,5,9', 0, 10).keys()].sort((a, b) => a - b)).toEqual([1, 5, 9]);
  });

  it('handles "*/N"', () => {
    expect([...expandCronField('*/15', 0, 59)]).toEqual([0, 15, 30, 45]);
  });

  it('clamps to bounds', () => {
    expect([...expandCronField('60', 0, 59)].length).toBe(0);
    expect([...expandCronField('1-100', 0, 5)]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('cronMatches', () => {
  it('matches the local minute, hour, date, month, and weekday', () => {
    expect(cronMatches('42 23 31 12 4', new Date(2026, 11, 31, 23, 42))).toBe(true);
    expect(cronMatches('42 23 31 12 4', new Date(2026, 11, 31, 22, 42))).toBe(false);
  });

  it('accepts both 0 and 7 as Sunday', () => {
    const sunday = new Date(2026, 9, 18, 9, 0);
    expect(cronMatches('0 9 * * 0', sunday)).toBe(true);
    expect(cronMatches('0 9 * * 7', sunday)).toBe(true);
    expect(cronMatches('0 9 * * 7', new Date(2026, 9, 19, 9, 0))).toBe(false);
  });

  it('includes Sunday in the weekday range 1-7', () => {
    for (let day = 18; day <= 24; day += 1) {
      expect(cronMatches('* * * * 1-7', new Date(2026, 9, day, 9, 0))).toBe(true);
    }
  });

  it('matches "* * * * *" always', () => {
    expect(cronMatches('* * * * *', new Date(2026, 3, 27, 15, 42))).toBe(true);
  });

  it('matches a specific minute', () => {
    expect(cronMatches('30 * * * *', new Date(2026, 3, 27, 15, 30))).toBe(true);
    expect(cronMatches('30 * * * *', new Date(2026, 3, 27, 15, 31))).toBe(false);
  });

  it('matches a weekday range "1-5"', () => {
    // 2026-04-27 is a Monday (dow=1).
    expect(cronMatches('0 9 * * 1-5', new Date(2026, 3, 27, 9, 0))).toBe(true);
    // 2026-04-26 is Sunday (dow=0) — outside 1-5.
    expect(cronMatches('0 9 * * 1-5', new Date(2026, 3, 26, 9, 0))).toBe(false);
  });

  it('matches step "*/15" minutes', () => {
    expect(cronMatches('*/15 * * * *', new Date(2026, 3, 27, 15, 0))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(2026, 3, 27, 15, 7))).toBe(false);
    expect(cronMatches('*/15 * * * *', new Date(2026, 3, 27, 15, 30))).toBe(true);
  });

  it('returns false for malformed expressions', () => {
    expect(cronMatches('not a cron', new Date())).toBe(false);
    expect(cronMatches('* * *', new Date())).toBe(false);
  });
});
