// Small HTTP helpers shared by the control-panel route handlers.

import type { SqliteDriver } from '../db/driver.ts';

export interface RequestContext {
  db: SqliteDriver;
  /** Path segments after the matched route prefix, already URL-decoded. */
  params: string[];
  url: URL;
  req: Request;
}

export type Handler = (ctx: RequestContext) => Promise<Response> | Response;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // The panel is same-origin only; nothing here should ever be embedded or
  // sniffed as another type.
  'x-content-type-options': 'nosniff',
} as const;

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

/** Consistent error envelope so the client can render failures uniformly. */
export function fail(message: string, status = 400, detail?: unknown): Response {
  return json({ error: message, ...(detail === undefined ? {} : { detail }) }, status);
}

/**
 * Parses a JSON request body, rejecting anything that isn't an object. Every
 * mutating endpoint takes an object, so this doubles as input validation.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError('request body is not valid JSON', 400);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError('request body must be a JSON object', 400);
  }
  return raw as Record<string, unknown>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly detail?: unknown;

  constructor(message: string, status = 400, detail?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** Records a mutation in the audit log. Never throws — auditing must not break the write. */
export function audit(db: SqliteDriver, action: string, target: string, detail?: unknown): void {
  try {
    db.run('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)', [
      Date.now(),
      'web',
      action,
      target,
      detail === undefined ? null : JSON.stringify(detail),
    ]);
  } catch {
    // An audit failure is not worth failing the user's edit over.
  }
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(`"${key}" is required and must be a non-empty string`);
  }
  return value;
}
