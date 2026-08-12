// Access control for the web control panel.
//
// The panel can read and write API keys, edit shell-command hooks and start
// processes, so it is treated as a privileged surface even on loopback: a
// token is required by default, and the browser never receives it back after
// the initial handoff — it is exchanged for an httpOnly session cookie.
//
// Only SHA-256 hashes are persisted. A lost token is regenerated, not
// recovered.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SqliteDriver } from '../db/driver.ts';

const COOKIE_NAME = 'asterisk_session';

export interface TokenRow {
  id: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a token, stores its hash, and returns the plaintext exactly once. */
export function issueToken(db: SqliteDriver, label = 'cli'): string {
  const token = randomBytes(32).toString('base64url');
  db.run('INSERT INTO web_tokens (label, token_hash, created_at) VALUES (?, ?, ?)', [
    label,
    hash(token),
    Date.now(),
  ]);
  return token;
}

export function listTokens(db: SqliteDriver): TokenRow[] {
  return db.all<TokenRow>(
    'SELECT id, label, created_at, last_used_at FROM web_tokens ORDER BY created_at DESC',
  );
}

export function revokeToken(db: SqliteDriver, id: number): boolean {
  const existing = db.get<{ id: number }>('SELECT id FROM web_tokens WHERE id = ?', [id]);
  if (!existing) return false;
  db.run('DELETE FROM web_tokens WHERE id = ?', [id]);
  return true;
}

export function revokeAllTokens(db: SqliteDriver): void {
  db.run('DELETE FROM web_tokens');
}

export function hasAnyToken(db: SqliteDriver): boolean {
  return (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM web_tokens')?.n ?? 0) > 0;
}

/**
 * Constant-time comparison of two hex digests. Lengths are equal by
 * construction (both are SHA-256 hex), but the guard keeps timingSafeEqual
 * from throwing if that ever stops being true.
 */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Verifies a plaintext token, recording the hit against its row. */
export function verifyToken(db: SqliteDriver, token: string): boolean {
  if (!token) return false;
  const candidate = hash(token);
  const rows = db.all<{ id: number; token_hash: string }>('SELECT id, token_hash FROM web_tokens');

  // Every row is compared even after a match so the work is independent of
  // which token was supplied.
  let matched: number | undefined;
  for (const row of rows) {
    if (digestsMatch(candidate, row.token_hash)) matched = row.id;
  }
  if (matched === undefined) return false;

  db.run('UPDATE web_tokens SET last_used_at = ? WHERE id = ?', [Date.now(), matched]);
  return true;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export interface AuthOutcome {
  ok: boolean;
  /** Set when a valid token arrived outside a cookie and should be promoted. */
  setCookie?: string;
}

/**
 * Authenticates a request. A token may arrive as a bearer header, as a
 * `?token=` query parameter (the link printed at startup), or as the session
 * cookie issued after either of those succeeds.
 */
export function authenticate(
  db: SqliteDriver,
  req: Request,
  opts: { required: boolean; secure: boolean },
): AuthOutcome {
  if (!opts.required) return { ok: true };

  const cookie = readCookie(req.headers.get('cookie'), COOKIE_NAME);
  if (cookie && verifyToken(db, cookie)) return { ok: true };

  const header = req.headers.get('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const query = new URL(req.url).searchParams.get('token') ?? '';
  const supplied = bearer || query;

  if (supplied && verifyToken(db, supplied)) {
    const attrs = [
      `${COOKIE_NAME}=${supplied}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=604800',
      ...(opts.secure ? ['Secure'] : []),
    ];
    return { ok: true, setCookie: attrs.join('; ') };
  }

  return { ok: false };
}

export { COOKIE_NAME };
