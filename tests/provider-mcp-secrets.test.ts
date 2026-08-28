// Three independent hardening fixes that share one property: each was silent.
//
// 1. Anthropic.APIConnectionError extends APIError, so the connection branch of
//    mapAnthropicError was unreachable. Network errors became kind 'unknown',
//    which is not retryable — the retry machinery was bypassed for the most
//    common transient failure there is.
// 2. Stdio MCP servers were handed the entire process.env, so installing any
//    third-party server handed it every credential in the shell.
// 3. writeSecrets deleted every key the caller had not supplied, so a partial
//    save destroyed the other credentials.

import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteSecrets, readSecrets, writeSecrets } from '../src/config/store.ts';
import { openDriver } from '../src/db/driver.ts';
import type { SqliteDriver } from '../src/db/driver.ts';
import { migrate } from '../src/db/migrations.ts';
import { stdioEnv } from '../src/mcp/client.ts';
import { mapAnthropicError } from '../src/providers/anthropic.ts';
import { isRetryable } from '../src/providers/errors.ts';

describe('Anthropic error mapping', () => {
  it('classifies a connection failure as retryable network', () => {
    const err = mapAnthropicError(
      new Anthropic.APIConnectionError({ message: 'ECONNREFUSED 1.2.3.4:443' }),
    );
    expect(err.kind).toBe('network');
    expect(isRetryable(err)).toBe(true);
  });

  it('classifies a status-less APIError as network rather than unknown', () => {
    const raw = new Anthropic.APIError(undefined, undefined, 'socket hang up', undefined);
    const err = mapAnthropicError(raw);
    expect(err.kind).toBe('network');
    expect(isRetryable(err)).toBe(true);
  });

  it('still maps real HTTP statuses through classifyHttpError', () => {
    // Headers is a web `Headers` instance since the SDK dropped its node-fetch
    // shims; a plain object here would compile but never yield Retry-After.
    const rateLimited = new Anthropic.APIError(
      429,
      undefined,
      'rate limited',
      new Headers({ 'retry-after': '12' }),
    );
    const err = mapAnthropicError(rateLimited);
    expect(err.kind).toBe('rate-limit');
    expect(isRetryable(err)).toBe(true);
    expect(err.retryAfterSeconds).toBe(12);

    const unauthorised = new Anthropic.APIError(401, undefined, 'bad key', undefined);
    expect(mapAnthropicError(unauthorised).kind).toBe('auth');
    expect(isRetryable(mapAnthropicError(unauthorised))).toBe(false);
  });

  it('maps an abort to the aborted kind', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(mapAnthropicError(abort).kind).toBe('aborted');
  });

  it('maps the SDK abort error to aborted rather than retryable network', () => {
    // APIUserAbortError extends APIError with an undefined status and carries
    // no `name`, so without an explicit branch a cancelled turn was retried.
    const err = mapAnthropicError(new Anthropic.APIUserAbortError());
    expect(err.kind).toBe('aborted');
    expect(isRetryable(err)).toBe(false);
  });
});

describe('stdio MCP environment', () => {
  const secrets = [
    'ANTHROPIC_API_KEY',
    'ASTERISK_TELEGRAM_BOT_TOKEN',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'OPENAI_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of secrets) {
      saved[key] = process.env[key];
      process.env[key] = `secret-${key}`;
    }
  });

  afterEach(() => {
    for (const key of secrets) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('withholds every credential in the parent environment', () => {
    const env = stdioEnv({});
    for (const key of secrets) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('passes through the variables a subprocess needs to run', () => {
    const env = stdioEnv({});
    expect(env['PATH']).toBe(process.env['PATH']);
    expect(env['HOME']).toBe(process.env['HOME']);
  });

  it('passes a secret only when the server declares it explicitly', () => {
    const env = stdioEnv({ GITHUB_TOKEN: 'ghp_declared' });
    expect(env['GITHUB_TOKEN']).toBe('ghp_declared');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('lets a server override an allowlisted variable', () => {
    expect(stdioEnv({ PATH: '/custom/bin' })['PATH']).toBe('/custom/bin');
  });
});

describe('secret store writes', () => {
  let db: SqliteDriver;
  const envKeys = ['ANTHROPIC_API_KEY', 'ASTERISK_TELEGRAM_BOT_TOKEN'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // readSecrets lets env win over the database, which would mask what the
    // store actually holds.
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    db = openDriver(':memory:');
    migrate(db);
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    db.close();
  });

  it('preserves keys a partial update does not mention', () => {
    writeSecrets(db, {
      ANTHROPIC_API_KEY: 'sk-ant-original',
      ASTERISK_TELEGRAM_BOT_TOKEN: '123:telegram',
    });

    // The destructive case: saving one key from a form that carries only that
    // key used to wipe the rest.
    writeSecrets(db, { ANTHROPIC_API_KEY: 'sk-ant-rotated' });

    const after = readSecrets(db);
    expect(after.ANTHROPIC_API_KEY).toBe('sk-ant-rotated');
    expect(after.ASTERISK_TELEGRAM_BOT_TOKEN).toBe('123:telegram');
  });

  it('deletes a key when given an explicit empty string', () => {
    writeSecrets(db, { ANTHROPIC_API_KEY: 'sk-ant-x' });
    writeSecrets(db, { ANTHROPIC_API_KEY: '' });
    expect(readSecrets(db).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('removes keys through the explicit delete path', () => {
    writeSecrets(db, {
      ANTHROPIC_API_KEY: 'sk-ant-x',
      ASTERISK_TELEGRAM_BOT_TOKEN: '123:telegram',
    });
    deleteSecrets(db, ['ASTERISK_TELEGRAM_BOT_TOKEN']);

    const after = readSecrets(db);
    expect(after.ANTHROPIC_API_KEY).toBe('sk-ant-x');
    expect(after.ASTERISK_TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});
