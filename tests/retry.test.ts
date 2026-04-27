import { describe, expect, it, vi } from 'vitest';

import { ProviderError, classifyHttpError, isRetryable, parseRetryAfter, retryAfterMs } from '../src/providers/errors.ts';
import { retry, sleep } from '../src/utils/retry.ts';

describe('classifyHttpError', () => {
  it('classifies 429 as rate-limit and surfaces Retry-After', () => {
    const err = classifyHttpError(429, 'too many requests', 7);
    expect(err.kind).toBe('rate-limit');
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(7);
    expect(retryAfterMs(err)).toBe(7000);
    expect(isRetryable(err)).toBe(true);
  });

  it('classifies 529 as overloaded', () => {
    expect(classifyHttpError(529, 'overloaded').kind).toBe('overloaded');
  });

  it('classifies 5xx as server', () => {
    expect(classifyHttpError(503, 'oops').kind).toBe('server');
    expect(isRetryable(classifyHttpError(503, 'oops'))).toBe(true);
  });

  it('classifies 401/403 as auth and is not retryable', () => {
    expect(classifyHttpError(401, 'bad key').kind).toBe('auth');
    expect(classifyHttpError(403, 'forbidden').kind).toBe('auth');
    expect(isRetryable(classifyHttpError(401, 'bad key'))).toBe(false);
  });

  it('classifies 400 with prompt-too-long as context-overflow', () => {
    const err = classifyHttpError(400, 'input tokens exceed model context window');
    expect(err.kind).toBe('context-overflow');
    expect(isRetryable(err)).toBe(false);
  });

  it('classifies plain 400 as bad-request', () => {
    expect(classifyHttpError(400, 'invalid model parameter').kind).toBe('bad-request');
  });
});

describe('parseRetryAfter', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
  });

  it('returns undefined for HTTP dates and garbage', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('retry()', () => {
  it('returns the value on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retry(fn, {
      classifier: () => ({ retry: true }),
    });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw classifyHttpError(503, 'transient');
      return 'ok';
    });
    const onRetry = vi.fn();
    const result = await retry(fn, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 5,
      classifier: (e) => ({ retry: isRetryable(e) }),
      onRetry,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('stops on non-retryable errors immediately', async () => {
    const err = classifyHttpError(401, 'bad key');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retry(fn, {
        classifier: (e) => ({ retry: isRetryable(e) }),
      }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after maxAttempts even on retryable errors', async () => {
    const err = classifyHttpError(500, 'down');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        classifier: (e) => ({ retry: isRetryable(e) }),
      }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After-derived retryAfterMs from classifier', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 2) throw classifyHttpError(429, 'limited', 1);
      return 'done';
    });
    const onRetry = vi.fn();
    await retry(fn, {
      maxAttempts: 3,
      baseDelayMs: 5000, // would dominate without override
      classifier: (e) => {
        const result: { retry: boolean; retryAfterMs?: number } = { retry: isRetryable(e) };
        const after = retryAfterMs(e);
        if (after !== undefined) result.retryAfterMs = after;
        return result;
      },
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const delay = onRetry.mock.calls[0]?.[1] as number;
    expect(delay).toBe(1000); // Retry-After: 1 second wins over the 5s base
  });

  it('aborts immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fn = vi.fn().mockResolvedValue('never');
    await expect(
      retry(fn, {
        signal: ctrl.signal,
        classifier: () => ({ retry: true }),
      }),
    ).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('sleep()', () => {
  it('rejects when the signal aborts mid-sleep', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    await expect(sleep(60_000, ctrl.signal)).rejects.toThrow();
  });

  it('classifies an instance of ProviderError correctly', () => {
    const err = new ProviderError('rate-limit', 'limited', { status: 429, retryAfterSeconds: 2 });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate-limit');
  });
});
