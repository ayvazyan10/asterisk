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
  it('matches "* * * * *" always', () => {
    expect(cronMatches('* * * * *', new Date('2026-04-27T15:42:00Z'))).toBe(true);
  });

  it('matches a specific minute', () => {
    expect(cronMatches('30 * * * *', new Date('2026-04-27T15:30:00Z'))).toBe(true);
    expect(cronMatches('30 * * * *', new Date('2026-04-27T15:31:00Z'))).toBe(false);
  });

  it('matches a weekday range "1-5"', () => {
    // 2026-04-27 is a Monday (UTC dow=1).
    expect(cronMatches('0 9 * * 1-5', new Date('2026-04-27T09:00:00Z'))).toBe(true);
    // 2026-04-26 is Sunday (UTC dow=0) — outside 1-5.
    expect(cronMatches('0 9 * * 1-5', new Date('2026-04-26T09:00:00Z'))).toBe(false);
  });

  it('matches step "*/15" minutes', () => {
    expect(cronMatches('*/15 * * * *', new Date('2026-04-27T15:00:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date('2026-04-27T15:07:00Z'))).toBe(false);
    expect(cronMatches('*/15 * * * *', new Date('2026-04-27T15:30:00Z'))).toBe(true);
  });

  it('returns false for malformed expressions', () => {
    expect(cronMatches('not a cron', new Date())).toBe(false);
    expect(cronMatches('* * *', new Date())).toBe(false);
  });
});
