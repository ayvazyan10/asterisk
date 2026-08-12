// Model pricing.
//
// Rates are USD per million tokens. The built-in table covers Anthropic's
// published list prices; anything else (local models, proxies, other vendors)
// has no entry and simply reports no cost rather than a wrong one.
//
// Cache rates follow Anthropic's published multipliers rather than being
// listed separately: a 5-minute cache write costs 1.25x the base input rate,
// a cache read 0.1x. The 1-hour TTL write multiplier is 2x — Asterisk only
// ever sends the default ephemeral TTL, so 1.25x is the right one here.

import type { SqliteDriver } from './driver.ts';

export interface ModelPrice {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  source: 'builtin' | 'user';
}

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Published Anthropic list prices, USD per million tokens. */
const BUILTIN: ReadonlyArray<readonly [model: string, input: number, output: number]> = [
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-haiku-4-5', 1, 5],
];

interface PricingRow {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  source: string;
}

function rowToPrice(row: PricingRow): ModelPrice {
  return {
    model: row.model,
    inputPerMTok: row.input_per_mtok,
    outputPerMTok: row.output_per_mtok,
    cacheWritePerMTok: row.cache_write_per_mtok ?? row.input_per_mtok * CACHE_WRITE_MULTIPLIER,
    cacheReadPerMTok: row.cache_read_per_mtok ?? row.input_per_mtok * CACHE_READ_MULTIPLIER,
    source: row.source === 'user' ? 'user' : 'builtin',
  };
}

/**
 * Inserts the built-in rates for any model not already present. User-edited
 * rows are never overwritten, so this is safe to call on every start.
 */
export function seedBuiltinPricing(db: SqliteDriver): void {
  db.transaction(() => {
    for (const [model, input, output] of BUILTIN) {
      db.run(
        `INSERT INTO model_pricing
           (model, input_per_mtok, output_per_mtok, cache_write_per_mtok,
            cache_read_per_mtok, source, updated_at)
         VALUES (?, ?, ?, ?, ?, 'builtin', ?)
         ON CONFLICT(model) DO NOTHING`,
        [
          model,
          input,
          output,
          input * CACHE_WRITE_MULTIPLIER,
          input * CACHE_READ_MULTIPLIER,
          Date.now(),
        ],
      );
    }
  });
}

/**
 * Normalises a model id for lookup. Anthropic aliases carry `-latest` or a
 * dated snapshot suffix; both name the same priced model.
 */
function normaliseModel(model: string): string[] {
  const candidates = [model];
  const withoutLatest = model.replace(/-latest$/, '');
  if (withoutLatest !== model) candidates.push(withoutLatest);
  const withoutDate = model.replace(/-\d{8}$/, '');
  if (withoutDate !== model) candidates.push(withoutDate);
  return candidates;
}

/** Looks up a price, trying the id then its alias-stripped forms. */
export function findPrice(db: SqliteDriver, model: string): ModelPrice | undefined {
  for (const candidate of normaliseModel(model)) {
    const row = db.get<PricingRow>('SELECT * FROM model_pricing WHERE model = ?', [candidate]);
    if (row) return rowToPrice(row);
  }
  return undefined;
}

export function listPricing(db: SqliteDriver): ModelPrice[] {
  return db.all<PricingRow>('SELECT * FROM model_pricing ORDER BY model').map(rowToPrice);
}

export function upsertPricing(
  db: SqliteDriver,
  input: {
    model: string;
    inputPerMTok: number;
    outputPerMTok: number;
    cacheWritePerMTok?: number;
    cacheReadPerMTok?: number;
  },
): ModelPrice {
  if (!input.model) throw new Error('model is required');
  for (const [key, value] of Object.entries(input)) {
    if (key === 'model') continue;
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    ) {
      throw new Error(`${key} must be a non-negative number`);
    }
  }

  db.run(
    `INSERT INTO model_pricing
       (model, input_per_mtok, output_per_mtok, cache_write_per_mtok,
        cache_read_per_mtok, source, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', ?)
     ON CONFLICT(model) DO UPDATE SET
       input_per_mtok       = excluded.input_per_mtok,
       output_per_mtok      = excluded.output_per_mtok,
       cache_write_per_mtok = excluded.cache_write_per_mtok,
       cache_read_per_mtok  = excluded.cache_read_per_mtok,
       source               = 'user',
       updated_at           = excluded.updated_at`,
    [
      input.model,
      input.inputPerMTok,
      input.outputPerMTok,
      input.cacheWritePerMTok ?? input.inputPerMTok * CACHE_WRITE_MULTIPLIER,
      input.cacheReadPerMTok ?? input.inputPerMTok * CACHE_READ_MULTIPLIER,
      Date.now(),
    ],
  );

  const price = findPrice(db, input.model);
  if (!price) throw new Error(`failed to persist pricing for "${input.model}"`);
  return price;
}

export function deletePricing(db: SqliteDriver, model: string): boolean {
  if (!db.get('SELECT model FROM model_pricing WHERE model = ?', [model])) return false;
  db.run('DELETE FROM model_pricing WHERE model = ?', [model]);
  return true;
}

export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Cost of one turn in USD, or undefined when the model has no known price.
 *
 * Anthropic reports `inputTokens` as the *uncached remainder*, with cached
 * tokens counted separately, so the three input figures are additive rather
 * than overlapping.
 */
export function costOf(price: ModelPrice | undefined, tokens: TokenCounts): number | undefined {
  if (!price) return undefined;
  const perToken = (rate: number) => rate / 1_000_000;
  return (
    (tokens.inputTokens ?? 0) * perToken(price.inputPerMTok) +
    (tokens.outputTokens ?? 0) * perToken(price.outputPerMTok) +
    (tokens.cacheCreationInputTokens ?? 0) * perToken(price.cacheWritePerMTok) +
    (tokens.cacheReadInputTokens ?? 0) * perToken(price.cacheReadPerMTok)
  );
}
