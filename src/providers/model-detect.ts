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
//
// Vision is detected the same way, and for the same reason: whether the loaded
// model has an mmproj attached is a fact about the server, not about its name.
// llama.cpp publishes it twice — `models[].capabilities` in the ollama-shaped
// half of `/v1/models`, and `modalities.vision` at `/props` — and both are
// vendor extensions, so everything here parses defensively and degrades to
// "the server did not say" rather than throwing. A detection failure must cost
// the caller a fallback, never a turn.

const CACHE_TTL_MS = 60_000;

export interface DetectedModel {
  id: string;
  /** Context window the server reports, when it reports one. */
  contextWindow?: number;
  /**
   * Whether the server says this model accepts images. Absent means it said
   * nothing — which is not the same as "no", and the caller must not read it
   * as one.
   */
  vision?: boolean;
}

interface CacheEntry {
  at: number;
  value: DetectedModel | null;
}

const cache = new Map<string, CacheEntry>();
/** `/props` answers, on the same TTL — see `detectVisionSupport`. */
const propsCache = new Map<string, { at: number; value: boolean | undefined }>();

/** Drops cached detections. Used by `/model` and by tests. */
export function clearDetectedModels(baseUrl?: string): void {
  if (baseUrl === undefined) {
    cache.clear();
    propsCache.clear();
    return;
  }
  const key = normalise(baseUrl);
  cache.delete(key);
  propsCache.delete(key);
}

function normalise(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

interface WireModel {
  id?: unknown;
  meta?: { n_ctx?: unknown; n_ctx_train?: unknown };
}

/** The ollama-compatible half of llama.cpp's listing, where capabilities live. */
interface WireOllamaModel {
  name?: unknown;
  model?: unknown;
  capabilities?: unknown;
}

/**
 * Reads a `capabilities` array, when the entry has one.
 *
 * Returns undefined for anything that is not an array of strings, so a server
 * that spells this field differently falls through to the next signal instead
 * of being recorded as text-only.
 */
function capabilitiesOf(entry: WireOllamaModel | undefined): string[] | undefined {
  const caps = entry?.capabilities;
  if (!Array.isArray(caps)) return undefined;
  const strings = caps.filter((c): c is string => typeof c === 'string');
  return strings.length > 0 ? strings.map((c) => c.toLowerCase()) : undefined;
}

/**
 * Finds the `models[]` entry describing `id`, falling back to the first.
 *
 * The two arrays are not index-aligned by contract — `data[]` is the OpenAI
 * shape and `models[]` the ollama one — so the id is matched rather than the
 * position, and position is only the fallback for a server that lists one
 * model under a different label in each half.
 */
function ollamaEntryFor(body: unknown, id: string): WireOllamaModel | undefined {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models) || models.length === 0) return undefined;
  const entries = models.filter((m): m is WireOllamaModel => !!m && typeof m === 'object');
  const named = entries.find((m) => m.name === id || m.model === id);
  return named ?? entries[0];
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

  // llama.cpp answers `/v1/models` with both shapes in one body, and only the
  // ollama-shaped half carries capabilities. A listing that has the array says
  // so either way — "multimodal" absent from a list that exists is a real no,
  // not silence — which is why this is a boolean and not a truthiness check.
  const caps = capabilitiesOf(ollamaEntryFor(body, id));
  const vision = caps === undefined ? undefined : caps.includes('multimodal');

  return {
    id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(vision === undefined ? {} : { vision }),
  };
}

/**
 * Reads `modalities.vision` out of llama.cpp's `/props`.
 *
 * Undefined for anything else — an older build, a proxy that answers HTML, a
 * body with the key spelled another way. Only an explicit boolean counts.
 */
export function parsePropsResponse(body: unknown): boolean | undefined {
  const modalities = (body as { modalities?: unknown })?.modalities;
  if (!modalities || typeof modalities !== 'object') return undefined;
  const vision = (modalities as { vision?: unknown }).vision;
  return typeof vision === 'boolean' ? vision : undefined;
}

/**
 * `/props` sits at the server root, one level above the OpenAI namespace.
 *
 * `baseUrl` points at the versioned endpoint (`…:8080/v1`) because that is
 * what `/chat/completions` hangs off; `/props` does not, so the version
 * segment is dropped when there is one.
 */
export function propsUrlFor(baseUrl: string): string {
  return `${normalise(baseUrl).replace(/\/v\d+$/, '')}/props`;
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

/**
 * What the server says about images, or undefined when it says nothing.
 *
 * Two signals, cheapest first. `/v1/models` is already fetched and cached for
 * the model id, so a llama.cpp build new enough to list `capabilities` costs
 * nothing extra. Only when that field is missing is `/props` asked, and that
 * answer gets its own entry on the same TTL — a server that 404s it is asked
 * once a minute at most, and never on the `send()` path.
 */
export async function detectVisionSupport(
  baseUrl: string,
  apiKey = '',
  opts: DetectOptions = {},
): Promise<boolean | undefined> {
  const key = normalise(baseUrl);
  if (!key) return undefined;

  const listed = await detectActiveModel(baseUrl, apiKey, opts);
  if (listed?.vision !== undefined) return listed.vision;

  const cached = propsCache.get(key);
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value: boolean | undefined;
  try {
    const res = await fetch(propsUrlFor(baseUrl), {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (res.ok) value = parsePropsResponse(await res.json());
  } catch {
    // No endpoint, no JSON, or no answer in time. All the same thing here.
    value = undefined;
  }

  propsCache.set(key, { at: Date.now(), value });
  return value;
}
