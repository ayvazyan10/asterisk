// Token-usage recording and aggregation.
//
// One row per agent turn. Local models are recorded with a cost of 0 rather
// than NULL — "free" and "unknown" are different answers, and conflating them
// makes lifetime totals silently wrong.

import type { SqliteDriver } from './driver.ts';
import { costOf, findPrice, type TokenCounts } from './pricing.ts';

export interface UsageRecord {
  sessionScope: string;
  sessionId: string;
  provider: string;
  model: string;
  tokens: TokenCounts;
  modelCalls: number;
}

export interface UsageRow {
  id: number;
  at: number;
  session_scope: string;
  session_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  model_calls: number;
  cost_usd: number | null;
}

/** True when every counter is absent or zero — nothing worth a row. */
export function isEmptyUsage(tokens: TokenCounts): boolean {
  return (
    !tokens.inputTokens &&
    !tokens.outputTokens &&
    !tokens.cacheCreationInputTokens &&
    !tokens.cacheReadInputTokens
  );
}

export function recordUsage(db: SqliteDriver, record: UsageRecord): void {
  const { tokens } = record;

  // Local inference has no marginal cost. Anything else without a price row
  // records NULL, which the summaries surface as "unpriced" rather than free.
  const cost =
    record.provider === 'ollama' ? 0 : costOf(findPrice(db, record.model), tokens);

  db.run(
    `INSERT INTO usage
       (at, session_scope, session_id, provider, model, input_tokens, output_tokens,
        cache_write_tokens, cache_read_tokens, model_calls, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      record.sessionScope,
      record.sessionId,
      record.provider,
      record.model,
      tokens.inputTokens ?? 0,
      tokens.outputTokens ?? 0,
      tokens.cacheCreationInputTokens ?? 0,
      tokens.cacheReadInputTokens ?? 0,
      record.modelCalls,
      cost === undefined ? null : cost,
    ],
  );
}

export interface UsageTotals {
  turns: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Summed cost of the priced rows only. */
  costUsd: number;
  /** Rows with no known price — their tokens are counted, their cost is not. */
  unpricedTurns: number;
}

interface TotalsRow {
  turns: number | null;
  model_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  unpriced: number | null;
}

const TOTALS_SELECT = `
  SELECT COUNT(*) AS turns,
         SUM(model_calls)        AS model_calls,
         SUM(input_tokens)       AS input_tokens,
         SUM(output_tokens)      AS output_tokens,
         SUM(cache_write_tokens) AS cache_write_tokens,
         SUM(cache_read_tokens)  AS cache_read_tokens,
         SUM(cost_usd)           AS cost_usd,
         SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
  FROM usage`;

function toTotals(row: TotalsRow | undefined): UsageTotals {
  return {
    turns: row?.turns ?? 0,
    modelCalls: row?.model_calls ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cacheWriteTokens: row?.cache_write_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    costUsd: row?.cost_usd ?? 0,
    unpricedTurns: row?.unpriced ?? 0,
  };
}

/** Lifetime totals across every session. */
export function totalUsage(db: SqliteDriver): UsageTotals {
  return toTotals(db.get<TotalsRow>(TOTALS_SELECT));
}

/** Totals for one session (`repl`, a Telegram chat, a sub-agent, …). */
export function sessionUsage(db: SqliteDriver, scope: string, id: string): UsageTotals {
  return toTotals(
    db.get<TotalsRow>(`${TOTALS_SELECT} WHERE session_scope = ? AND session_id = ?`, [scope, id]),
  );
}

/** Totals since a timestamp — the basis for day/week/month breakdowns. */
export function usageSince(db: SqliteDriver, since: number): UsageTotals {
  return toTotals(db.get<TotalsRow>(`${TOTALS_SELECT} WHERE at >= ?`, [since]));
}

export interface ModelBreakdown extends UsageTotals {
  provider: string;
  model: string;
}

/** Per-model totals, most expensive first, then by token volume. */
export function usageByModel(db: SqliteDriver, since = 0): ModelBreakdown[] {
  const rows = db.all<TotalsRow & { provider: string; model: string }>(
    `${TOTALS_SELECT.replace('FROM usage', ', provider, model FROM usage')}
     WHERE at >= ?
     GROUP BY provider, model
     ORDER BY COALESCE(SUM(cost_usd), 0) DESC, SUM(output_tokens) DESC`,
    [since],
  );
  return rows.map((row) => ({ ...toTotals(row), provider: row.provider, model: row.model }));
}

export interface DailyUsage extends UsageTotals {
  /** Local-time day boundary, as an epoch-millisecond timestamp. */
  day: number;
}

/**
 * Per-day totals for the last `days` days. Days are bucketed in the host's
 * local timezone so "today" matches what the user sees on a clock.
 */
export function usageByDay(db: SqliteDriver, days: number): DailyUsage[] {
  const start = startOfLocalDay(Date.now()) - (days - 1) * 86_400_000;
  const rows = db.all<UsageRow>('SELECT * FROM usage WHERE at >= ? ORDER BY at', [start]);

  const buckets = new Map<number, DailyUsage>();
  for (let i = 0; i < days; i++) {
    const day = start + i * 86_400_000;
    buckets.set(day, { ...toTotals(undefined), day });
  }

  for (const row of rows) {
    const day = startOfLocalDay(row.at);
    const bucket = buckets.get(day);
    if (!bucket) continue;
    bucket.turns += 1;
    bucket.modelCalls += row.model_calls;
    bucket.inputTokens += row.input_tokens;
    bucket.outputTokens += row.output_tokens;
    bucket.cacheWriteTokens += row.cache_write_tokens;
    bucket.cacheReadTokens += row.cache_read_tokens;
    if (row.cost_usd === null) bucket.unpricedTurns += 1;
    else bucket.costUsd += row.cost_usd;
  }

  return [...buckets.values()].sort((a, b) => a.day - b.day);
}

/**
 * Midnight local time for the day containing `ts`. Computed via the Date
 * constructor rather than by rounding the epoch, so it stays correct across
 * timezones with non-hour offsets and DST transitions.
 */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The most recent turns, newest first. */
export function recentUsage(db: SqliteDriver, limit = 20): UsageRow[] {
  return db.all<UsageRow>('SELECT * FROM usage ORDER BY at DESC, id DESC LIMIT ?', [limit]);
}

/** Deletes every usage row. Returns how many were removed. */
export function clearUsage(db: SqliteDriver): number {
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM usage')?.n ?? 0;
  db.run('DELETE FROM usage');
  return before;
}
