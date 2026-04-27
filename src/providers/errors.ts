// Structured provider error with a kind that downstream retry logic and the
// REPL can branch on. Lets us classify HTTP failures once at the provider
// boundary instead of pattern-matching messages all over the codebase.

export type ProviderErrorKind =
  | 'rate-limit' // 429
  | 'overloaded' // 529 / overloaded_error
  | 'server' // other 5xx
  | 'network' // fetch failure / DNS / timeout
  | 'auth' // 401, 403 with auth signature
  | 'bad-request' // 400 — model input rejected, not retryable
  | 'context-overflow' // 400 with prompt-too-long signature
  | 'aborted' // user / signal cancellation
  | 'unknown';

export interface ProviderErrorOptions {
  status?: number;
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  retryAfterSeconds?: number;

  constructor(kind: ProviderErrorKind, message: string, opts: ProviderErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'rate-limit',
  'overloaded',
  'server',
  'network',
]);

export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return RETRYABLE_KINDS.has(error.kind);
  // Bun/Node fetch surfaces transport failures as TypeError('fetch failed').
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return true;
  // AbortError -> not retryable.
  return false;
}

export function isAbort(error: unknown): boolean {
  if (error instanceof ProviderError) return error.kind === 'aborted';
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

export function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
    return Math.max(0, error.retryAfterSeconds * 1000);
  }
  return undefined;
}

// Classify an HTTP response (any provider) into a ProviderError.
export function classifyHttpError(
  status: number,
  body: string,
  retryAfterSeconds?: number,
): ProviderError {
  const opts: ProviderErrorOptions = { status };
  if (retryAfterSeconds !== undefined) opts.retryAfterSeconds = retryAfterSeconds;

  if (status === 429) return new ProviderError('rate-limit', truncate(body, 400), opts);
  if (status === 529) return new ProviderError('overloaded', truncate(body, 400), opts);
  if (status >= 500) return new ProviderError('server', `server ${status}: ${truncate(body, 300)}`, opts);
  if (status === 401 || status === 403)
    return new ProviderError('auth', `auth error (${status}): ${truncate(body, 200)}`, opts);
  if (status === 400) {
    if (
      /(prompt|context).*(too long|exceeds?|over)|max_tokens.*(context|window)|input.*tokens.*exceed/i.test(
        body,
      )
    ) {
      return new ProviderError('context-overflow', truncate(body, 400), opts);
    }
    return new ProviderError('bad-request', truncate(body, 400), opts);
  }
  return new ProviderError('unknown', `${status}: ${truncate(body, 300)}`, opts);
}

export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // Per HTTP RFC 7231 §7.1.3, Retry-After can also be an HTTP date. We don't
  // parse those here — the caller falls through to exponential backoff if we
  // return undefined.
  return undefined;
}

function truncate(text: string, max: number): string {
  if (!text) return '(empty)';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
