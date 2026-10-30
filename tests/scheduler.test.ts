import { describe, expect, it } from 'vitest';

import { cronMatches, expandCronField, validateCron } from '../src/daemon/scheduler.ts';

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
  it('matches either restricted day-of-month or day-of-week', () => {
    expect(cronMatches('0 9 1 * 1', new Date(2026, 9, 5, 9, 0))).toBe(true);
    expect(cronMatches('0 9 1 * 1', new Date(2026, 9, 1, 9, 0))).toBe(true);
    expect(cronMatches('0 9 1 * 1', new Date(2026, 9, 6, 9, 0))).toBe(false);
    expect(cronMatches('0 9 1 9 1', new Date(2026, 9, 5, 9, 0))).toBe(false);
    expect(cronMatches('0 9 1 * 1', new Date(2026, 9, 5, 9, 1))).toBe(false);
  });

  it('matches 74 distinct days for the first, fifteenth, or Monday in 2026', () => {
    let count = 0;
    for (let day = 1; day <= 365; day += 1) {
      const date = new Date(2026, 0, day, 9, 0);
      const expected = date.getDate() === 1 || date.getDate() === 15 || date.getDay() === 1;
      const matches = cronMatches('0 9 1,15 * 1', date);
      expect(matches).toBe(expected);
      if (matches) count += 1;
    }
    expect(count).toBe(74);
  });

  it('requires the day-of-month when the weekday is a wildcard', () => {
    expect(cronMatches('0 9 1 * *', new Date(2026, 9, 1, 9, 0))).toBe(true);
    expect(cronMatches('0 9 1 * *', new Date(2026, 9, 5, 9, 0))).toBe(false);
  });

  it('keeps AND semantics for fields starting with a stepped wildcard', () => {
    expect(cronMatches('0 9 */2 * 1', new Date(2026, 9, 5, 9, 0))).toBe(true);
    expect(cronMatches('0 9 */2 * 1', new Date(2026, 9, 12, 9, 0))).toBe(false);
    expect(cronMatches('0 9 */2 * 1', new Date(2026, 9, 1, 9, 0))).toBe(false);
    expect(cronMatches('0 9 1 * */2', new Date(2026, 9, 1, 9, 0))).toBe(true);
    expect(cronMatches('0 9 1 * */2', new Date(2026, 9, 8, 9, 0))).toBe(false);
  });

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

describe('validateCron', () => {
  it.each([
    '0 9 * * 1-5',
    '*/15 * * * *',
    '0 9 * * 7',
    '0 0 29 2 *',
    '0,30 9-17/2 1,15 * 1',
    '5/2 * * * *',
    '0 9 31 2,3 *',
    '0 9 28,31 2 *',
    '0 9 31 2 1',
  ])('accepts %s', (expr) => {
    expect(validateCron(expr)).toBeNull();
  });

  it.each([
    ['0 9 * * mon', 'day-of-week'],
    ['0 9 * * MON-FRI', 'day-of-week'],
    ['60 * * * *', 'minute'],
    ['0 24 * * *', 'hour'],
    ['0 17-9 * * *', 'hour'],
    ['0 9 31 2 *', 'day-of-month'],
    ['5x * * * *', 'minute'],
    ['0 9am * * *', 'hour'],
    ['*/0 * * * *', 'minute'],
    ['0 9 0 * *', 'day-of-month'],
    ['0 9 32 * *', 'day-of-month'],
    ['0 9 * 0 *', 'month'],
    ['0 9 * 13 *', 'month'],
    ['0 9 * * 8', 'day-of-week'],
    ['0 9 31 4,6 *', 'day-of-month'],
    ['0 9 31 2 */2', 'day-of-month'],
    ['0, 9 * * *', 'minute'],
    ['0 9 *-3 * *', 'day-of-month'],
    ['0 9 * * -1', 'day-of-week'],
    ['*/1.5 * * * *', 'minute'],
    ['0-60 * * * *', 'minute'],
  ])('rejects %s and names the %s field', (expr, field) => {
    expect(validateCron(expr)).toContain(field);
  });

  it.each(['', '* * * *', '* * * * * *'])('rejects the wrong field count: %s', (expr) => {
    expect(validateCron(expr)).toContain('5-field');
  });
});
