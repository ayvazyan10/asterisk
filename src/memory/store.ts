// Durable agent memory — the notes the model writes for itself and reads back
// in a later session, long after the conversation that produced them has been
// compacted away.
//
// Memory is install-wide on purpose: a note taken in the REPL has to be
// findable from a Telegram turn, which is the entire point. That does mean two
// people talking to the same bot share one memory; `source` is the column to
// filter on if per-user isolation is ever wanted.
//
// Search goes through FTS5 when the SQLite build has it and through LIKE when
// it does not. The `memories` table is the record of truth either way, so the
// difference is ranking and speed, never whether a note can be stored.

import type { SqlParam, SqliteDriver } from '../db/driver.ts';
import { MEMORY_FTS_SQL, applyOptionalSql } from '../db/migrations.ts';

export interface MemoryRecord {
  id: number;
  content: string;
  tags: string[];
  source: string;
  createdAt: number;
}

export interface NewMemory {
  content: string;
  tags?: readonly string[];
  source?: string;
}

interface MemoryRow {
  id: number;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

const COLUMNS = 'id, content, tags, source, created_at';
const JOINED_COLUMNS = 'm.id, m.content, m.tags, m.source, m.created_at';

/** A model that pastes a paragraph into `query` should get a search, not a
 *  200-term MATCH expression. Past a handful of terms the extra ones only
 *  narrow an already-narrow result set. */
const MAX_QUERY_TERMS = 24;
const MAX_TAGS = 16;
const MAX_RESULTS = 50;
const DEFAULT_LIMIT = 10;

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    content: row.content,
    tags: row.tags ? row.tags.split(' ') : [],
    source: row.source,
    createdAt: row.created_at,
  };
}

/**
 * Tags are stored as one space-separated string, so anything that would break
 * that round-trip has to go here. Splitting on commas as well as whitespace
 * means a model that writes `["ops, deploy"]` gets two tags rather than one
 * with a comma stuck to it.
 */
export function normaliseTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    for (const part of tag.toLowerCase().split(/[\s,]+/)) {
      if (part) out.add(part);
    }
  }
  return [...out].slice(0, MAX_TAGS);
}

/**
 * Splits an untrusted query into bare terms.
 *
 * Everything the model sends is treated as text to look for, never as FTS5
 * syntax. That is not politeness — a lone `"`, a trailing `:` or a bare `*`
 * makes MATCH throw a syntax error, and `AND` / `OR` / `NOT` / `NEAR` are
 * reserved words that either error or silently mean something the user did not
 * ask for. Keeping only letters, digits and underscores drops every character
 * that carries meaning to the FTS5 parser, so nothing is left to escape.
 */
export function queryTerms(raw: string): string[] {
  return (raw.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, MAX_QUERY_TERMS);
}

/**
 * The FTS5 MATCH expression for a raw query, or '' when it holds no searchable
 * term. Terms are double-quoted so reserved words match as literals; a term
 * cannot contain a quote of its own, queryTerms having already dropped it.
 * Adjacent terms are implicitly ANDed by FTS5.
 */
export function toMatchQuery(raw: string): string {
  return queryTerms(raw)
    .map((t) => `"${t}"`)
    .join(' ');
}

// Availability is a property of the database file plus the runtime's SQLite
// build, so it is settled once per connection. Keyed by driver rather than
// held in a module-level flag because tests open a fresh in-memory database
// per case and must not inherit the previous one's answer.
const indexState = new WeakMap<SqliteDriver, boolean>();

/**
 * Whether FTS5 search is usable on this connection, creating the index if the
 * build has gained FTS5 since the database was migrated.
 *
 * The check is a real query rather than a look in sqlite_master, because the
 * bad case is asymmetric: a database written by an FTS5-capable build and then
 * opened by one without still has `memories_fts` listed, and only touching it
 * reveals that the module backing it is gone.
 */
export function searchIndexReady(db: SqliteDriver): boolean {
  const cached = indexState.get(db);
  if (cached !== undefined) return cached;

  let ready = probeIndex(db);
  if (!ready && applyOptionalSql(db, MEMORY_FTS_SQL)) {
    // Freshly created, so it has to be filled from whatever the LIKE fallback
    // has been storing in the meantime. 'rebuild' is FTS5's own backfill for
    // external-content tables and reads straight from `memories`.
    ready =
      probeIndex(db) &&
      applyOptionalSql(db, `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
  }

  indexState.set(db, ready);
  return ready;
}

function probeIndex(db: SqliteDriver): boolean {
  try {
    db.get('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 1', ['"probe"']);
    return true;
  } catch {
    return false;
  }
}

/** Stores a note and returns it as persisted. Throws on empty content — a
 *  memory with nothing in it is a bug in the caller, not a user error. */
export function rememberMemory(db: SqliteDriver, input: NewMemory): MemoryRecord {
  const content = input.content.trim();
  if (!content) throw new Error('memory content is empty');

  const tags = normaliseTags(input.tags ?? []);
  const packed = tags.join(' ');
  const source = input.source?.trim() || 'unknown';
  const createdAt = Date.now();
  const indexed = searchIndexReady(db);

  const id = db.transaction(() => {
    const row = db.get<{ id: number }>(
      `INSERT INTO memories (content, tags, source, created_at) VALUES (?, ?, ?, ?)
       RETURNING id`,
      [content, packed, source, createdAt],
    );
    if (!row) throw new Error('memory insert returned no id');
    // Indexed here rather than by an AFTER INSERT trigger. A trigger would put
    // the index on the write path, so a build without FTS5 could not store a
    // memory at all — which is the failure the fallback exists to avoid.
    if (indexed) {
      db.run('INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)', [
        row.id,
        content,
        packed,
      ]);
    }
    return row.id;
  });

  return { id, content, tags, source, createdAt };
}

/** Best matches for `query`, or [] when it holds no searchable term. */
export function recallMemories(
  db: SqliteDriver,
  query: string,
  limit = DEFAULT_LIMIT,
): MemoryRecord[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const capped = clampLimit(limit);
  return searchIndexReady(db) ? matchSearch(db, query, capped) : likeSearch(db, terms, capped);
}

/** Most recently stored notes — what recall shows when there is nothing to
 *  search for. */
export function recentMemories(db: SqliteDriver, limit = DEFAULT_LIMIT): MemoryRecord[] {
  return db
    .all<MemoryRow>(`SELECT ${COLUMNS} FROM memories ORDER BY created_at DESC, id DESC LIMIT ?`, [
      clampLimit(limit),
    ])
    .map(toRecord);
}

export function countMemories(db: SqliteDriver): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memories')?.n ?? 0;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), MAX_RESULTS));
}

function matchSearch(db: SqliteDriver, query: string, limit: number): MemoryRecord[] {
  try {
    return db
      .all<MemoryRow>(
        `SELECT ${JOINED_COLUMNS}
         FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY bm25(memories_fts), m.created_at DESC
         LIMIT ?`,
        [toMatchQuery(query), limit],
      )
      .map(toRecord);
  } catch {
    // Every character that carries meaning to the FTS5 parser is already gone,
    // so reaching here means the index itself became unusable after the probe
    // passed. Degrading to substring search is a worse answer than bm25;
    // failing the turn is a much worse one. The demotion is remembered so the
    // next call does not pay for the retry.
    indexState.set(db, false);
    return likeSearch(db, queryTerms(query), limit);
  }
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Substring fallback. Slower and unranked, but it needs nothing beyond core
 * SQLite. Terms are ANDed to mirror FTS5's implicit conjunction; the clause is
 * built from the term *count*, and every term is bound, so nothing the model
 * wrote reaches the SQL text.
 */
function likeSearch(db: SqliteDriver, terms: readonly string[], limit: number): MemoryRecord[] {
  const clause = terms
    .map(() => `(content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`)
    .join(' AND ');
  const params: SqlParam[] = [];
  for (const term of terms) {
    const pattern = `%${escapeLike(term)}%`;
    params.push(pattern, pattern);
  }
  params.push(limit);

  return db
    .all<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    )
    .map(toRecord);
}

/**
 * Deletes one memory, or false when there was nothing with that id.
 *
 * An external-content FTS5 index is un-indexed with
 * `INSERT INTO … VALUES('delete', rowid, …)`, handing back the exact values
 * that were indexed. Measured behaviour of the alternatives, against
 * bun:sqlite:
 *
 *   * a plain `DELETE FROM memories_fts WHERE rowid = ?` works only while the
 *     base row still exists — FTS5 reads it to learn which terms to remove.
 *     Run it after the row is gone and it neither throws nor removes anything.
 *   * the `'delete'` command given values that differ from what was indexed
 *     also does not throw, and leaves the terms behind.
 *
 * So the explicit form is used with the row's own columns, read inside the
 * transaction. That makes correctness independent of statement order rather
 * than resting on the fact that this function happens to touch the index
 * first — a later edit reordering these two statements would otherwise start
 * leaking index entries silently.
 */
export function forgetMemory(db: SqliteDriver, id: number): boolean {
  return db.transaction(() => {
    const row = db.get<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE id = ?`, [id]);
    if (!row) return false;

    if (searchIndexReady(db)) {
      db.run(
        `INSERT INTO memories_fts (memories_fts, rowid, content, tags) VALUES ('delete', ?, ?, ?)`,
        [row.id, row.content, row.tags],
      );
    }
    db.run('DELETE FROM memories WHERE id = ?', [id]);
    return true;
  });
}

/** Drops every memory. Exposed for `/memory clear`, never as a model tool. */
export function forgetAllMemories(db: SqliteDriver): number {
  return db.transaction(() => {
    const count = countMemories(db);
    db.run('DELETE FROM memories');
    // 'delete-all' is the external-content table's own reset command; dropping
    // rows from the base table leaves the index fully populated otherwise.
    if (searchIndexReady(db)) {
      db.run(`INSERT INTO memories_fts (memories_fts) VALUES ('delete-all')`);
    }
    return count;
  });
}

/** One memory by id, for confirming what a delete is about to remove. */
export function getMemory(db: SqliteDriver, id: number): MemoryRecord | null {
  const row = db.get<MemoryRow>(`SELECT ${COLUMNS} FROM memories WHERE id = ?`, [id]);
  return row ? toRecord(row) : null;
}
