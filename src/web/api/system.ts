// System endpoints — daemon lifecycle, diagnostics, logs, access tokens and
// the audit trail.

import { existsSync, statSync } from 'node:fs';

import { readConfig } from '../../config/store.ts';
import { asteriskPaths } from '../../daemon/paths.ts';
import { logs, restart, start, status, stop } from '../../daemon/lifecycle.ts';
import { listHooks, listMcpServers } from '../../db/collections.ts';
import { getVersion } from '../../version.ts';
import { issueToken, listTokens, revokeToken } from '../auth.ts';
import { audit, type Handler, HttpError, json, readJsonObject } from '../http.ts';

/** Snapshot for the dashboard header. */
export const getStatus: Handler = ({ db }) => {
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

  return json({
    version: getVersion(),
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    home: paths.root,
    database: { path: paths.dbFile, bytes: dbBytes },
    daemon: { running: daemon.message.startsWith('running'), message: daemon.message },
    provider: config.provider,
    model: config.provider === 'anthropic' ? config.anthropic.model : config.ollama.model,
    outputStyle: config.outputStyle,
    counts: {
      mcpServers: listMcpServers(db).length,
      hooks: listHooks(db).length,
      enabledMcpServers: listMcpServers(db).filter((s) => s.enabled).length,
      enabledHooks: listHooks(db).filter((h) => h.enabled).length,
    },
    bots: {
      telegram: config.bots.telegram.enabled,
      whatsapp: config.bots.whatsapp.enabled,
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

  // Ollama reachability — the default provider, so worth checking either way.
  const base = config.ollama.baseUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const models = body.models ?? [];
      const present = models.some((m) => m.name === config.ollama.model);
      checks.push({
        name: 'Ollama',
        ok: true,
        detail: `${models.length} model(s) at ${base}${
          present ? '' : ` — configured model "${config.ollama.model}" not pulled`
        }`,
      });
    } else {
      checks.push({ name: 'Ollama', ok: false, detail: `HTTP ${res.status} from ${base}` });
    }
  } catch (e) {
    checks.push({ name: 'Ollama', ok: false, detail: `unreachable at ${base}: ${(e as Error).message}` });
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
      detail:
        server.transport === 'stdio'
          ? `stdio — ${server.command}`
          : `http — ${server.url}`,
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
