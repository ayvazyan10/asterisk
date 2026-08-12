// Text rendering for the /cost and /usage commands, and for the Telegram
// bridge's /cost. Kept out of the command registry so the same formatting
// serves the REPL, the bots and the web panel.

import { getDb } from '../db/index.ts';
import { listPricing } from '../db/pricing.ts';
import {
  type UsageTotals,
  sessionUsage,
  startOfLocalDay,
  totalUsage,
  usageByDay,
  usageByModel,
  usageSince,
} from '../db/usage.ts';

/** Compact token counts: 1234 -> 1.2k, 4500000 -> 4.5M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Money, with enough precision to stay useful at Asterisk's scale — a turn
 * against Haiku can cost a small fraction of a cent, and rounding that to
 * $0.00 makes the whole feature look broken.
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function costCell(totals: UsageTotals): string {
  if (totals.turns === 0) return '—';
  const cost = formatCost(totals.costUsd);
  // Unpriced rows have real tokens but no rate, so the figure is a floor.
  return totals.unpricedTurns > 0 ? `${cost}+ (${totals.unpricedTurns} unpriced)` : cost;
}

function line(label: string, totals: UsageTotals): string {
  if (totals.turns === 0) return `  ${label.padEnd(12)} —`;
  return (
    `  ${label.padEnd(12)}${costCell(totals).padEnd(24)}` +
    `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ` +
    `${totals.turns} turn${totals.turns === 1 ? '' : 's'}`
  );
}

const DAY = 86_400_000;

/**
 * `MM-DD` for a local-midnight timestamp. Deliberately not `toISOString()`:
 * that renders in UTC, so east-of-Greenwich hosts would label today's bucket
 * with yesterday's date.
 */
export function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `/cost` — this session, today, and lifetime, plus a per-model split. */
export function renderCost(scope: string, id: string): string {
  const db = getDb();
  const today = startOfLocalDay(Date.now());

  const out: string[] = ['Cost'];
  out.push(line('session', sessionUsage(db, scope, id)));
  out.push(line('today', usageSince(db, today)));
  out.push(line('last 7d', usageSince(db, today - 6 * DAY)));
  out.push(line('lifetime', totalUsage(db)));

  const byModel = usageByModel(db);
  if (byModel.length > 0) {
    out.push('', 'By model');
    for (const row of byModel) {
      const name = `${row.provider}:${row.model}`;
      const cost =
        row.unpricedTurns > 0 && row.costUsd === 0 ? 'unpriced' : formatCost(row.costUsd);
      out.push(
        `  ${name.length > 34 ? `${name.slice(0, 33)}…` : name.padEnd(34)} ` +
          `${cost.padStart(11)}  ${formatTokens(row.inputTokens)} in · ` +
          `${formatTokens(row.outputTokens)} out`,
      );
    }
  }

  if (totalUsage(db).turns === 0) {
    out.push(
      '',
      'No usage recorded yet. Counts land here after the first turn that',
      'reports token usage — Ollama and Anthropic both do.',
    );
  }

  const unpriced = totalUsage(db).unpricedTurns;
  if (unpriced > 0) {
    out.push(
      '',
      `${unpriced} turn${unpriced === 1 ? '' : 's'} ran on a model with no configured price.`,
      'Set one in the web panel (Usage → Pricing) to include them in totals.',
    );
  }

  return out.join('\n');
}

/** `/usage` — day, week and month rollups plus a 14-day chart. */
export function renderUsage(days = 14): string {
  const db = getDb();
  const today = startOfLocalDay(Date.now());

  const out: string[] = ['Usage'];
  out.push(line('today', usageSince(db, today)));
  out.push(line('last 7d', usageSince(db, today - 6 * DAY)));
  out.push(line('last 30d', usageSince(db, today - 29 * DAY)));
  out.push(line('lifetime', totalUsage(db)));

  const daily = usageByDay(db, days);
  const peak = Math.max(1, ...daily.map((d) => d.inputTokens + d.outputTokens));

  out.push('', `Last ${days} days`);
  for (const day of daily) {
    const total = day.inputTokens + day.outputTokens;
    const bars = total === 0 ? 0 : Math.max(1, Math.round((total / peak) * 24));
    const label = dayLabel(day.day);
    out.push(
      `  ${label}  ${'█'.repeat(bars).padEnd(24)} ` +
        `${formatTokens(total).padStart(7)}  ${day.turns === 0 ? '' : costCell(day)}`,
    );
  }

  const priced = listPricing(db).length;
  out.push('', `${priced} model price${priced === 1 ? '' : 's'} configured.`);

  return out.join('\n');
}

/** Shorter form for chat bridges, where wide monospace tables render badly. */
export function renderCostCompact(scope: string, id: string): string {
  const db = getDb();
  const today = startOfLocalDay(Date.now());
  const session = sessionUsage(db, scope, id);
  const lifetime = totalUsage(db);

  return [
    '*Cost*',
    `This chat: ${costCell(session)} · ${formatTokens(session.inputTokens + session.outputTokens)} tokens · ${session.turns} turns`,
    `Today: ${costCell(usageSince(db, today))}`,
    `Lifetime: ${costCell(lifetime)}`,
  ].join('\n');
}
