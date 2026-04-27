// Generic exponential-backoff retry wrapper with jitter, Retry-After
// honoring, and AbortSignal cancellation. Used by the agent loop around
// provider.send and could wrap any other transient-failure-prone async call.

export interface RetryClassifierResult {
  retry: boolean;
  retryAfterMs?: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  signal?: AbortSignal;
  classifier(error: unknown): RetryClassifierResult;
  onRetry?(attempt: number, delayMs: number, error: unknown): void;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 32_000;
  const jitterFactor = opts.jitterFactor ?? 0.25;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw signalAbortError(opts.signal);
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;

      const decision = opts.classifier(error);
      if (!decision.retry) throw error;

      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * exponential * jitterFactor);
      const delay = decision.retryAfterMs ?? exponential + jitter;

      opts.onRetry?.(attempt, delay, error);
      await sleep(delay, opts.signal);
    }
  }

  // Unreachable in practice — the loop either returns or throws — but TS
  // wants a final value to satisfy the return type.
  throw lastError ?? new Error('retry exhausted with no error');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signalAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signalAbortError(signal));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function signalAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
