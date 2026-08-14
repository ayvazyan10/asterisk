// Which model is actually loaded on the server.
//
// A local server holds exactly one model at a time, and the user changes it by
// restarting the server — not by editing Asterisk's config. Keeping a model
// name in the config therefore guaranteed a stale copy of a fact the server
// already publishes: `GET /v1/models` names what is loaded, and llama.cpp adds
// `meta.n_ctx`, the context window it was actually started with.
//
// That second field is worth as much as the first. Without it, compaction fell
// back to a 128k guess — on a server started with 262144 that wasted more than
// half the window, and on one started with 8192 it overflowed before
// compaction ever fired.
//
// The result is cached briefly rather than pinned: swapping the model on the
// server should take effect on its own, but not at the cost of an HTTP request
// per turn.

const CACHE_TTL_MS = 60_000;

export interface DetectedModel {
  id: string;
  /** Context window the server reports, when it reports one. */
  contextWindow?: number;
}

interface CacheEntry {
  at: number;
  value: DetectedModel | null;
}

const cache = new Map<string, CacheEntry>();

/** Drops cached detections. Used by `/model` and by tests. */
export function clearDetectedModels(baseUrl?: string): void {
  if (baseUrl === undefined) cache.clear();
  else cache.delete(normalise(baseUrl));
}

function normalise(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

interface WireModel {
  id?: unknown;
  meta?: { n_ctx?: unknown; n_ctx_train?: unknown };
}

/**
 * Reads the first model the endpoint lists.
 *
 * "First" rather than "best": a local server serves one, and an endpoint that
 * serves many has no way to tell us which one the user meant — that is what
 * pinning `openaiCompatible.model` is for.
 */
export function parseModelsResponse(body: unknown): DetectedModel | null {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0] as WireModel;
  const id = typeof first?.id === 'string' ? first.id.trim() : '';
  if (!id) return null;

  // n_ctx is the window the server was started with; n_ctx_train is the
  // model's maximum. The former is what the request will actually be held to.
  const raw = first.meta?.n_ctx ?? first.meta?.n_ctx_train;
  const contextWindow = typeof raw === 'number' && raw > 0 ? raw : undefined;

  return { id, ...(contextWindow ? { contextWindow } : {}) };
}

export interface DetectOptions {
  timeoutMs?: number;
  /** Skip the cache — `/model` uses this to force a fresh look. */
  force?: boolean;
}

/**
 * Asks the endpoint what it is serving. Returns null when it cannot be
 * reached or says nothing useful — the caller then falls back to whatever the
 * config pinned, so an unreachable server surfaces as a connection error on
 * the real request rather than as a confusing detection failure.
 */
export async function detectActiveModel(
  baseUrl: string,
  apiKey = '',
  opts: DetectOptions = {},
): Promise<DetectedModel | null> {
  const key = normalise(baseUrl);
  if (!key) return null;

  const cached = cache.get(key);
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value: DetectedModel | null = null;
  try {
    const res = await fetch(`${key}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (res.ok) value = parseModelsResponse(await res.json());
  } catch {
    // Unreachable, timed out, or answered with something that is not JSON.
    value = null;
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}
