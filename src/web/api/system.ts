// System endpoints — daemon lifecycle, diagnostics, logs, access tokens and
// the audit trail.

import { existsSync, statSync } from 'node:fs';

import type { AsteriskConfig, SecretKey } from '../../config/schema.ts';
import { readConfig } from '../../config/store.ts';
import { logs, restart, start, status, stop } from '../../daemon/lifecycle.ts';
import { asteriskPaths } from '../../daemon/paths.ts';
import { listHooks, listMcpServers } from '../../db/collections.ts';
import type { SqliteDriver } from '../../db/driver.ts';
import { getSecret } from '../../db/settings.ts';
import { detectActiveModel } from '../../providers/model-detect.ts';
import { getVersion } from '../../version.ts';
import { issueToken, listTokens, revokeToken } from '../auth.ts';
import { type Handler, HttpError, audit, json, readJsonObject } from '../http.ts';
import { listConnectors } from './connectors.ts';

/** What the header chip renders — see `resolveBackend` below. */
export interface StatusModel {
  id: string;
  /** 'detected' from the server itself; 'configured' from a pin in settings. */
  source: 'detected' | 'configured';
}

/**
 * The model a given backend will answer with.
 *
 * The Anthropic and DeepSeek providers have no detection endpoint, so their
 * pin is always "configured" — neither model setting is ever blank (see the
 * schema defaults). The openai-compatible provider is asked what it is
 * serving; that call is cached 60s by `detectActiveModel`, so this is cheap,
 * and a short timeout keeps the status endpoint responsive when the server is
 * unreachable. A pinned `openaiCompatible.model` is the fallback when
 * detection fails, and `null` — never a placeholder string — means there is
 * nothing to report.
 */
async function resolveBackend(
  config: AsteriskConfig,
  kind: AsteriskConfig['provider'],
): Promise<{ model: StatusModel | null; reachable: boolean; contextWindow?: number }> {
  if (kind === 'deepseek') {
    return { model: { id: config.deepseek.model, source: 'configured' }, reachable: false };
  }
  if (kind === 'anthropic') {
    return { model: { id: config.anthropic.model, source: 'configured' }, reachable: false };
  }
  const base = config.openaiCompatible.baseUrl.replace(/\/$/, '');
  const detected = await detectActiveModel(base, '', { timeoutMs: 1500 });
  if (detected) {
    return {
      model: { id: detected.id, source: 'detected' },
      reachable: true,
      ...(detected.contextWindow ? { contextWindow: detected.contextWindow } : {}),
    };
  }
  const pinned = config.openaiCompatible.model;
  return { model: pinned ? { id: pinned, source: 'configured' } : null, reachable: false };
}

/** One backend in the order the agent loop tries them — see `getStatus`. */
export interface ChainEntry {
  provider: AsteriskConfig['provider'];
  model: StatusModel | null;
  /**
   * Whether this backend can be expected to answer: a local server that
   * reported a model, or a hosted API with its key present. Not a live call
   * to a hosted API — that would spend the user's quota on every refresh.
   */
  ready: boolean;
  /** What stands in the way when `ready` is false, in the user's words. */
  reason?: string;
  /** Where a local server is reached, for the person reading the panel. */
  endpoint?: string;
  contextWindow?: number;
}

/** Which secret a hosted backend needs. Local servers need none. */
const KEY_FOR: Partial<Record<AsteriskConfig['provider'], SecretKey>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The primary provider followed by `providerFallback`, de-duplicated the way
 * the fallback chain is built — the order the daemon logs as
 * `openai-compatible:auto → deepseek:deepseek-flash`.
 */
async function resolveChain(db: SqliteDriver, config: AsteriskConfig): Promise<ChainEntry[]> {
  const kinds = [config.provider, ...config.providerFallback].filter(
    (kind, i, all) => all.indexOf(kind) === i,
  );
  return Promise.all(
    kinds.map(async (kind): Promise<ChainEntry> => {
      const backend = await resolveBackend(config, kind);
      const key = KEY_FOR[kind];
      if (!key) {
        const endpoint = hostOf(config.openaiCompatible.baseUrl);
        return {
          provider: kind,
          model: backend.model,
          ready: backend.reachable,
          endpoint,
          ...(backend.reachable ? {} : { reason: `Nothing answered at ${endpoint}` }),
          ...(backend.contextWindow ? { contextWindow: backend.contextWindow } : {}),
        };
      }
      const hasKey = Boolean(process.env[key] || getSecret(db, key));
      return {
        provider: kind,
        model: backend.model,
        ready: hasKey,
        ...(hasKey ? {} : { reason: `${key} is not set` }),
      };
    }),
  );
}

/** Snapshot for the dashboard header. */
export const getStatus: Handler = async ({ db }) => {
  const paths = asteriskPaths();
  const config = readConfig(db);
  const daemon = status();

  let logBytes = 0;
  try {
    if (existsSync(paths.daemonLog)) logBytes = statSync(paths.daemonLog).size;
  } catch {
    // Log size is decorative; a stat failure is not worth a 500.
  }

  let dbBytes = 0;
  try {
    if (existsSync(paths.dbFile)) dbBytes = statSync(paths.dbFile).size;
  } catch {
    // Same.
  }

  const chain = await resolveChain(db, config);
  // The header chip reports the primary backend, as it always has.
  const model = chain[0]?.model ?? null;

  return json({
    version: getVersion(),
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    home: paths.root,
    database: { path: paths.dbFile, bytes: dbBytes },
    daemon: { running: daemon.message.startsWith('running'), message: daemon.message },
    provider: config.provider,
    model,
    chain,
    outputStyle: config.outputStyle,
    counts: {
      mcpServers: listMcpServers(db).length,
      hooks: listHooks(db).length,
      enabledMcpServers: listMcpServers(db).filter((s) => s.enabled).length,
      enabledHooks: listHooks(db).filter((h) => h.enabled).length,
      // listConnectors() is the single source of "connected" — see the
      // comment on it in ./connectors.ts. The Connectors page filters the
      // same array for the same field; this just counts it.
      connectedConnectors: listConnectors(db).filter((c) => c.connected).length,
    },
    bots: {
      telegram: config.bots.telegram.enabled,
    },
    logBytes,
  });
};

/** Starts, stops or restarts the daemon. */
export const daemonAction: Handler = async ({ db, params }) => {
  const action = params[0];
  const runner =
    action === 'start' ? start : action === 'stop' ? stop : action === 'restart' ? restart : null;
  if (!runner) throw new HttpError(`unknown daemon action: ${action}`, 404);

  const result = await runner();
  audit(db, `daemon.${action}`, 'daemon', { ok: result.ok });
  return json(result, result.ok ? 200 : 409);
};

export const getLogs: Handler = ({ url }) => {
  const requested = Number(url.searchParams.get('lines') ?? '200');
  const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 2000) : 200;
  return json({ lines, text: logs(lines).message });
};

/**
 * Connectivity and environment checks. Mirrors what `/doctor` reports in the
 * REPL, but returns structured results the panel can render as a checklist.
 */
export const getDoctor: Handler = async ({ db }) => {
  const config = readConfig(db);
  const paths = asteriskPaths();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // The local endpoint, and what it is actually serving. With the model name
  // detected rather than configured, "reachable" alone is not enough to tell
  // the user their setup works — a server with nothing loaded answers too.
  const base = config.openaiCompatible.baseUrl.replace(/\/$/, '');
  const detected = await detectActiveModel(base, '', { force: true, timeoutMs: 4000 });
  if (detected) {
    const pinned = config.openaiCompatible.model;
    const mismatch = pinned && pinned !== detected.id ? ` — pinned to "${pinned}"` : '';
    const window = detected.contextWindow ? ` · ${detected.contextWindow} ctx` : '';
    checks.push({
      name: 'Local model',
      ok: true,
      detail: `${base} serving ${detected.id}${window}${mismatch}`,
    });
  } else {
    checks.push({
      name: 'Local model',
      ok: false,
      detail: `no model reported at ${base}/models`,
    });
  }

  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const storedKey = db.get<{ value: string }>('SELECT value FROM secrets WHERE key = ?', [
    'ANTHROPIC_API_KEY',
  ])?.value;
  checks.push({
    name: 'Anthropic API key',
    ok: Boolean(anthropicKey || storedKey),
    detail: anthropicKey
      ? 'present in environment'
      : storedKey
        ? 'stored in database'
        : 'not configured — the anthropic provider will fail',
  });

  checks.push({
    name: 'Database',
    ok: existsSync(paths.dbFile),
    detail: existsSync(paths.dbFile) ? paths.dbFile : 'missing',
  });

  const daemon = status();
  checks.push({
    name: 'Daemon',
    ok: daemon.message.startsWith('running'),
    detail: daemon.message,
  });

  for (const server of listMcpServers(db).filter((s) => s.enabled)) {
    checks.push({
      name: `MCP: ${server.name}`,
      ok: true,
      detail: server.transport === 'stdio' ? `stdio — ${server.command}` : `http — ${server.url}`,
    });
  }

  return json({ checks, ok: checks.every((c) => c.ok) });
};

// --- access tokens -------------------------------------------------------

export const getTokens: Handler = ({ db }) => json({ tokens: listTokens(db) });

export const postToken: Handler = async ({ db, req }) => {
  const body = await readJsonObject(req);
  const label = typeof body['label'] === 'string' && body['label'] ? body['label'] : 'panel';
  const token = issueToken(db, label);
  audit(db, 'token.issue', label);
  // The only time the plaintext is ever returned.
  return json({ ok: true, label, token });
};

export const deleteToken: Handler = ({ db, params }) => {
  const id = Number(params[0]);
  if (!Number.isInteger(id)) throw new HttpError('token id must be an integer');
  if (!revokeToken(db, id)) throw new HttpError('no such token', 404);
  audit(db, 'token.revoke', String(id));
  return json({ ok: true });
};

// --- audit ---------------------------------------------------------------

interface AuditRow {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string | null;
}

export const getAudit: Handler = ({ db, url }) => {
  const requested = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
  const rows = db.all<AuditRow>('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?', [
    limit,
  ]);
  return json({
    entries: rows.map((r) => ({
      ...r,
      detail: r.detail === null ? null : (JSON.parse(r.detail) as unknown),
    })),
  });
};
