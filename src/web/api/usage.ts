// Token-usage and pricing endpoints.

import { deletePricing, listPricing, upsertPricing } from '../../db/pricing.ts';
import {
  clearUsage,
  recentUsage,
  startOfLocalDay,
  totalUsage,
  usageByDay,
  usageByModel,
  usageSince,
} from '../../db/usage.ts';
import { type Handler, HttpError, audit, json, readJsonObject } from '../http.ts';

const DAY = 86_400_000;

export const getUsage: Handler = ({ db, url }) => {
  const requested = Number(url.searchParams.get('days') ?? '14');
  const days = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 90) : 14;
  const today = startOfLocalDay(Date.now());

  return json({
    days,
    totals: {
      today: usageSince(db, today),
      week: usageSince(db, today - 6 * DAY),
      month: usageSince(db, today - 29 * DAY),
      lifetime: totalUsage(db),
    },
    byModel: usageByModel(db),
    byDay: usageByDay(db, days),
    recent: recentUsage(db, 20),
  });
};

export const deleteUsage: Handler = ({ db }) => {
  const removed = clearUsage(db);
  audit(db, 'usage.clear', 'all', { removed });
  return json({ ok: true, removed });
};

export const getPricing: Handler = ({ db }) => json({ pricing: listPricing(db) });

export const putPricing: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const model = body['model'];
  if (typeof model !== 'string' || !model) throw new HttpError('"model" is required');

  const numeric = (key: string, required: boolean): number | undefined => {
    const value = body[key];
    if (value === undefined || value === null || value === '') {
      if (required) throw new HttpError(`"${key}" is required`);
      return undefined;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(`"${key}" must be a non-negative number`);
    return n;
  };

  // Parsed before the try so a malformed body stays a 400 rather than being
  // relabelled as a 422 by the catch below.
  const inputPerMTok = numeric('inputPerMTok', true) as number;
  const outputPerMTok = numeric('outputPerMTok', true) as number;
  const cacheWrite = numeric('cacheWritePerMTok', false);
  const cacheRead = numeric('cacheReadPerMTok', false);

  try {
    const saved = upsertPricing(db, {
      model,
      inputPerMTok,
      outputPerMTok,
      ...(cacheWrite !== undefined ? { cacheWritePerMTok: cacheWrite } : {}),
      ...(cacheRead !== undefined ? { cacheReadPerMTok: cacheRead } : {}),
    });
    audit(db, 'pricing.upsert', model);
    return json({ ok: true, pricing: saved });
  } catch (e) {
    throw new HttpError((e as Error).message, 422);
  }
};

export const removePricing: Handler = ({ db, params }) => {
  const model = params[0];
  if (!model) throw new HttpError('model is required');
  if (!deletePricing(db, model)) throw new HttpError(`no pricing for "${model}"`, 404);
  audit(db, 'pricing.delete', model);
  return json({ ok: true });
};
