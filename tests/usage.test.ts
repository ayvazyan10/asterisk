import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDriver, type SqliteDriver } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrations.ts';
import {
  costOf,
  deletePricing,
  findPrice,
  listPricing,
  seedBuiltinPricing,
  upsertPricing,
} from '../src/db/pricing.ts';
import {
  clearUsage,
  isEmptyUsage,
  recordUsage,
  sessionUsage,
  startOfLocalDay,
  totalUsage,
  usageByDay,
  usageByModel,
  usageSince,
} from '../src/db/usage.ts';
import { dayLabel, formatCost, formatTokens } from '../src/commands/usage-report.ts';

let db: SqliteDriver;

beforeEach(() => {
  db = openDriver(':memory:');
  migrate(db);
  seedBuiltinPricing(db);
});

afterEach(() => {
  db.close();
});

const record = (over: Partial<Parameters<typeof recordUsage>[1]> = {}) =>
  recordUsage(db, {
    sessionScope: 'repl',
    sessionId: 'repl',
    provider: 'anthropic',
    model: 'claude-opus-5',
    tokens: { inputTokens: 1000, outputTokens: 500 },
    modelCalls: 1,
    ...over,
  });

describe('pricing', () => {
  it('seeds published Anthropic rates', () => {
    expect(findPrice(db, 'claude-opus-5')).toMatchObject({
      inputPerMTok: 5,
      outputPerMTok: 25,
      source: 'builtin',
    });
    expect(findPrice(db, 'claude-haiku-4-5')).toMatchObject({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
    expect(findPrice(db, 'claude-fable-5')).toMatchObject({
      inputPerMTok: 10,
      outputPerMTok: 50,
    });
  });

  it('derives cache rates from the input rate', () => {
    // 1.25x for a 5-minute cache write, 0.1x for a cache read.
    expect(findPrice(db, 'claude-opus-5')).toMatchObject({
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.5,
    });
  });

  it('resolves -latest and dated aliases to the base model', () => {
    expect(findPrice(db, 'claude-opus-5-latest')?.inputPerMTok).toBe(5);
    expect(findPrice(db, 'claude-haiku-4-5-20251001')?.inputPerMTok).toBe(1);
  });

  it('returns nothing for an unknown model', () => {
    expect(findPrice(db, 'llama3:70b')).toBeUndefined();
  });

  it('seeding twice does not duplicate or overwrite user rates', () => {
    upsertPricing(db, { model: 'claude-opus-5', inputPerMTok: 99, outputPerMTok: 100 });
    seedBuiltinPricing(db);
    expect(findPrice(db, 'claude-opus-5')).toMatchObject({ inputPerMTok: 99, source: 'user' });
    expect(listPricing(db).filter((p) => p.model === 'claude-opus-5')).toHaveLength(1);
  });

  it('accepts a custom rate and deletes it', () => {
    upsertPricing(db, { model: 'my-proxy/gpt', inputPerMTok: 2, outputPerMTok: 4 });
    expect(findPrice(db, 'my-proxy/gpt')).toMatchObject({ outputPerMTok: 4, source: 'user' });
    expect(deletePricing(db, 'my-proxy/gpt')).toBe(true);
    expect(deletePricing(db, 'my-proxy/gpt')).toBe(false);
  });

  it('rejects negative rates', () => {
    expect(() =>
      upsertPricing(db, { model: 'x', inputPerMTok: -1, outputPerMTok: 1 }),
    ).toThrow();
  });
});

describe('cost calculation', () => {
  it('prices input and output separately', () => {
    const price = findPrice(db, 'claude-opus-5');
    // 1M input at $5 + 1M output at $25.
    expect(costOf(price, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(30, 6);
  });

  it('prices cache writes and reads at their own rates', () => {
    const price = findPrice(db, 'claude-opus-5');
    expect(
      costOf(price, { cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 }),
    ).toBeCloseTo(6.75, 6); // 6.25 + 0.5
  });

  it('treats the three input counters as additive, not overlapping', () => {
    const price = findPrice(db, 'claude-opus-5');
    const split = costOf(price, {
      inputTokens: 500_000,
      cacheReadInputTokens: 500_000,
    });
    expect(split).toBeCloseTo(2.5 + 0.25, 6);
  });

  it('returns undefined when the model has no price', () => {
    expect(costOf(undefined, { inputTokens: 1000 })).toBeUndefined();
  });
});

describe('usage recording', () => {
  it('detects an empty usage block', () => {
    expect(isEmptyUsage({})).toBe(true);
    expect(isEmptyUsage({ inputTokens: 0, outputTokens: 0 })).toBe(true);
    expect(isEmptyUsage({ outputTokens: 3 })).toBe(false);
  });

  it('records a priced turn with its cost', () => {
    record();
    const totals = totalUsage(db);
    expect(totals).toMatchObject({ turns: 1, inputTokens: 1000, outputTokens: 500 });
    // 1000 * $5/Mtok + 500 * $25/Mtok = 0.005 + 0.0125
    expect(totals.costUsd).toBeCloseTo(0.0175, 8);
    expect(totals.unpricedTurns).toBe(0);
  });

  it('records local models at zero cost, not as unpriced', () => {
    record({ provider: 'ollama', model: 'qwen3.5:9b-q8-max' });
    const totals = totalUsage(db);
    expect(totals.costUsd).toBe(0);
    expect(totals.unpricedTurns).toBe(0);
  });

  it('records an openai-compatible local endpoint at zero cost', () => {
    record({ provider: 'openai-compatible', model: 'gemma-4-26b' });
    expect(totalUsage(db)).toMatchObject({ costUsd: 0, unpricedTurns: 0 });
  });

  it('lets an explicit rate override the local-is-free rule', () => {
    // An openai-compatible endpoint may point at a paid hosted service.
    upsertPricing(db, { model: 'hosted-llm', inputPerMTok: 2, outputPerMTok: 6 });
    record({ provider: 'openai-compatible', model: 'hosted-llm' });
    // 1000 * $2/Mtok + 500 * $6/Mtok
    expect(totalUsage(db).costUsd).toBeCloseTo(0.005, 8);
  });

  it('flags an unknown paid model as unpriced rather than free', () => {
    record({ provider: 'anthropic', model: 'claude-unreleased-9' });
    const totals = totalUsage(db);
    expect(totals.unpricedTurns).toBe(1);
    expect(totals.costUsd).toBe(0);
    // Tokens still count even though the money doesn't.
    expect(totals.inputTokens).toBe(1000);
  });

  it('sums across turns and scopes to a session', () => {
    record();
    record();
    record({ sessionScope: 'telegram', sessionId: '42' });

    expect(totalUsage(db).turns).toBe(3);
    expect(sessionUsage(db, 'repl', 'repl').turns).toBe(2);
    expect(sessionUsage(db, 'telegram', '42').turns).toBe(1);
    expect(sessionUsage(db, 'telegram', '99').turns).toBe(0);
  });

  it('keeps model calls distinct from turns', () => {
    record({ modelCalls: 4 });
    expect(totalUsage(db)).toMatchObject({ turns: 1, modelCalls: 4 });
  });

  it('groups by provider and model', () => {
    record({ provider: 'ollama', model: 'a' });
    record({ provider: 'ollama', model: 'a' });
    record({ provider: 'anthropic', model: 'claude-opus-5' });

    const rows = usageByModel(db);
    expect(rows).toHaveLength(2);
    // Ordered by cost — the paid model comes first.
    expect(rows[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', turns: 1 });
    expect(rows[1]).toMatchObject({ provider: 'ollama', model: 'a', turns: 2 });
  });

  it('filters by timestamp', () => {
    record();
    expect(usageSince(db, Date.now() + 60_000).turns).toBe(0);
    expect(usageSince(db, startOfLocalDay(Date.now())).turns).toBe(1);
  });

  it('buckets by local day, including empty days', () => {
    record();
    const days = usageByDay(db, 7);
    expect(days).toHaveLength(7);
    expect(days[days.length - 1]).toMatchObject({ turns: 1, day: startOfLocalDay(Date.now()) });
    expect(days[0]?.turns).toBe(0);
    // Ascending order, one day apart.
    expect(days[1]!.day - days[0]!.day).toBe(86_400_000);
  });

  it('clears history and reports how many rows went', () => {
    record();
    record();
    expect(clearUsage(db)).toBe(2);
    expect(totalUsage(db).turns).toBe(0);
  });
});

describe('formatting', () => {
  it('abbreviates token counts', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });

  it('labels days in local time, not UTC', () => {
    // A local-midnight timestamp east of Greenwich falls on the previous UTC
    // day; the label must still read the local date.
    const midnight = startOfLocalDay(Date.now());
    const d = new Date(midnight);
    const expected = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(dayLabel(midnight)).toBe(expected);
    expect(dayLabel(midnight)).toBe(
      new Date(midnight).toLocaleDateString('en-CA').slice(5),
    );
  });

  it('keeps sub-cent costs visible instead of rounding them to zero', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0000175)).toBe('$0.00002');
    expect(formatCost(0.5)).toBe('$0.5000');
    expect(formatCost(12.345)).toBe('$12.35');
  });
});
