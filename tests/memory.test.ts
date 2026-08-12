// Persistent agent memory: the store, the FTS5 index, and what happens when
// the SQLite build has no FTS5 to offer.
//
// The FTS5-less runtime cannot be produced on demand — both bun:sqlite and
// node:sqlite ship with FTS5 compiled in — so it is simulated with a driver
// wrapper that fails exactly the statements such a build would fail. That is
// the same error, on the same code path, from the same call sites.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type SqlParam, type SqliteDriver, openDriver } from '../src/db/driver.ts';
import { closeDb } from '../src/db/index.ts';
import { MEMORY_FTS_SQL, applyOptionalSql, latestVersion, migrate } from '../src/db/migrations.ts';
import {
  countMemories,
  normaliseTags,
  queryTerms,
  recallMemories,
  recentMemories,
  rememberMemory,
  searchIndexReady,
  toMatchQuery,
} from '../src/memory/store.ts';
import { recallTool, rememberTool } from '../src/tools/memory.ts';

function fresh(): SqliteDriver {
  const db = openDriver(':memory:');
  migrate(db);
  return db;
}

/**
 * A driver that behaves like a SQLite build compiled without FTS5: every
 * statement naming the module or the virtual table fails the way such a build
 * fails, and everything else works normally.
 */
function withoutFts5(inner: SqliteDriver): SqliteDriver {
  // Matches the module and the virtual table, not the word "FTS5" wherever it
  // appears in a schema comment. Catalog reads are exempt: a build without
  // FTS5 can still see the sqlite_master row that an FTS5-capable build left
  // behind, which is what makes that row worthless as a readiness check.
  const guard = (sql: string): void => {
    if (/sqlite_master/i.test(sql)) return;
    if (/using\s+fts5|memories_fts/i.test(sql)) throw new Error('no such module: fts5');
  };
  return {
    exec(sql) {
      guard(sql);
      inner.exec(sql);
    },
    run(sql, params) {
      guard(sql);
      inner.run(sql, params);
    },
    get<T>(sql: string, params?: readonly SqlParam[]) {
      guard(sql);
      return inner.get<T>(sql, params);
    },
    all<T>(sql: string, params?: readonly SqlParam[]) {
      guard(sql);
      return inner.all<T>(sql, params);
    },
    transaction: (fn) => inner.transaction(fn),
    close: () => inner.close(),
  };
}

function seed(db: SqliteDriver): void {
  rememberMemory(db, { content: 'the deploy key lives in the ops vault', tags: ['ops', 'deploy'] });
  rememberMemory(db, { content: 'user prefers tabs over spaces', tags: ['style'] });
  rememberMemory(db, { content: 'the café release ships on Fridays', tags: ['release'] });
}

describe('memory schema', () => {
  it('migrates to version 5 with the base table and the FTS index', () => {
    const db = fresh();
    expect(latestVersion()).toBeGreaterThanOrEqual(5);
    expect(
      db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'memories'"),
    ).toBeDefined();
    expect(searchIndexReady(db)).toBe(true);
    db.close();
  });

  it('applyOptionalSql reports failure instead of throwing, and leaves the transaction usable', () => {
    const db = fresh();
    const survived = db.transaction(() => {
      const created = applyOptionalSql(db, 'CREATE VIRTUAL TABLE nope USING nosuchmodule(x)');
      expect(created).toBe(false);
      // The point of the whole exercise: work after the rejected statement
      // still commits.
      rememberMemory(db, { content: 'written after a rejected statement' });
      return countMemories(db);
    });
    expect(survived).toBe(1);
    db.close();
  });

  it('creating the index twice is caught rather than thrown', () => {
    const db = fresh();
    expect(applyOptionalSql(db, MEMORY_FTS_SQL)).toBe(false);
    db.close();
  });
});

describe('remember', () => {
  it('round-trips content, tags and source', () => {
    const db = fresh();
    const stored = rememberMemory(db, {
      content: '  the deploy key lives in the ops vault  ',
      tags: ['Ops', 'deploy'],
      source: 'telegram',
    });
    expect(stored.id).toBeGreaterThan(0);
    expect(stored.content).toBe('the deploy key lives in the ops vault');
    expect(stored.tags).toEqual(['ops', 'deploy']);
    expect(stored.source).toBe('telegram');
    expect(recentMemories(db)[0]).toEqual(stored);
    db.close();
  });

  it('rejects empty content', () => {
    const db = fresh();
    expect(() => rememberMemory(db, { content: '   ' })).toThrow(/empty/);
    expect(countMemories(db)).toBe(0);
    db.close();
  });

  it('splits and dedupes tags so they survive the space-joined column', () => {
    expect(normaliseTags(['ops, deploy', 'OPS', ' ci '])).toEqual(['ops', 'deploy', 'ci']);
    const db = fresh();
    const stored = rememberMemory(db, { content: 'note', tags: ['ops, deploy'] });
    expect(recentMemories(db)[0]?.tags).toEqual(stored.tags);
    expect(stored.tags).toEqual(['ops', 'deploy']);
    db.close();
  });

  it('defaults source to unknown', () => {
    const db = fresh();
    expect(rememberMemory(db, { content: 'note', source: '  ' }).source).toBe('unknown');
    db.close();
  });
});

describe('recall via FTS5', () => {
  it('finds by content word, by tag, and folds diacritics', () => {
    const db = fresh();
    seed(db);
    expect(recallMemories(db, 'vault')[0]?.content).toMatch(/deploy key/);
    expect(recallMemories(db, 'style')[0]?.content).toMatch(/tabs over spaces/);
    expect(recallMemories(db, 'cafe')[0]?.content).toMatch(/café release/);
    db.close();
  });

  it('ANDs terms and returns nothing for a term no memory holds', () => {
    const db = fresh();
    seed(db);
    expect(recallMemories(db, 'deploy vault')).toHaveLength(1);
    expect(recallMemories(db, 'deploy unicorn')).toHaveLength(0);
    db.close();
  });

  it('honours limit and clamps it to a sane range', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) rememberMemory(db, { content: `note ${i} about deploys` });
    expect(recallMemories(db, 'deploys', 2)).toHaveLength(2);
    expect(recallMemories(db, 'deploys', 0)).toHaveLength(1);
    expect(recallMemories(db, 'deploys', Number.NaN)).toHaveLength(5);
    db.close();
  });

  it('returns nothing when the query holds no searchable term', () => {
    const db = fresh();
    seed(db);
    expect(recallMemories(db, '???')).toHaveLength(0);
    db.close();
  });
});

describe('FTS5 query sanitisation', () => {
  // Anything in this list makes a bare MATCH throw, or quietly means something
  // the user never asked for. A model writes queries; it will produce all of
  // them eventually.
  const hostile = [
    'say "hi',
    'unbalanced " quote',
    'AND',
    'OR NOT',
    'NEAR(a b)',
    'content:',
    '*',
    '^',
    'deploy)',
    '- deploy',
    '{}',
  ];

  it('every hostile query would break a raw MATCH', () => {
    const db = fresh();
    seed(db);
    // Establishes that the sanitiser is load-bearing rather than decorative:
    // if this stops failing, the test below stops proving anything.
    const raw = (q: string): boolean => {
      try {
        db.all('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?', [q]);
        return true;
      } catch {
        return false;
      }
    };
    // Everything but NEAR() is a hard syntax error. NEAR() parses, and is in
    // the list for the other half of the problem: it means something the user
    // did not ask for.
    expect(hostile.filter(raw)).toEqual(['NEAR(a b)']);
    db.close();
  });

  it('survives every hostile query and still matches the words in it', () => {
    const db = fresh();
    seed(db);
    for (const q of hostile) {
      expect(() => recallMemories(db, q)).not.toThrow();
    }
    // Sanitisation is what absorbed those, not the emergency fallback in
    // matchSearch — the index is still trusted afterwards.
    expect(searchIndexReady(db)).toBe(true);
    // The words inside the punctuation are still honoured.
    expect(recallMemories(db, 'deploy)')[0]?.content).toMatch(/deploy key/);

    // Reserved words are matched as literals, so this asks for a memory
    // holding all three words — "and" included — rather than running a
    // boolean expression the user never wrote.
    expect(recallMemories(db, '"deploy" AND "vault"')).toHaveLength(0);
    rememberMemory(db, { content: 'deploy and vault are both nouns' });
    expect(recallMemories(db, '"deploy" AND "vault"')).toHaveLength(1);
    db.close();
  });

  it('quotes each term so reserved words match as literals', () => {
    expect(toMatchQuery('deploy key')).toBe('"deploy" "key"');
    expect(toMatchQuery('say "hi')).toBe('"say" "hi"');
    expect(toMatchQuery('NEAR(a b)')).toBe('"NEAR" "a" "b"');
    expect(toMatchQuery('***')).toBe('');
  });

  it('caps the number of terms so a pasted paragraph stays a query', () => {
    const long = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    expect(queryTerms(long)).toHaveLength(24);
  });

  it('matches a word written with an FTS5 operator glued to it', () => {
    const db = fresh();
    rememberMemory(db, { content: 'the fallback is LIKE based' });
    expect(recallMemories(db, 'fallback^')[0]?.content).toMatch(/fallback/);
    db.close();
  });
});

describe('without FTS5', () => {
  it('migrates, stores and searches through the LIKE fallback', () => {
    const inner = openDriver(':memory:');
    const db = withoutFts5(inner);
    // The migration must not fail just because the index cannot be built —
    // this database also holds the config, the secrets and the grants.
    expect(() => migrate(db)).not.toThrow();
    expect(searchIndexReady(db)).toBe(false);

    seed(db);
    expect(countMemories(db)).toBe(3);
    expect(recallMemories(db, 'vault')[0]?.content).toMatch(/deploy key/);
    expect(recallMemories(db, 'style')[0]?.content).toMatch(/tabs over spaces/);
    expect(recallMemories(db, 'deploy vault')).toHaveLength(1);
    expect(recallMemories(db, 'deploy unicorn')).toHaveLength(0);
    inner.close();
  });

  it('does not let a hostile query become a LIKE wildcard', () => {
    const inner = openDriver(':memory:');
    const db = withoutFts5(inner);
    migrate(db);
    rememberMemory(db, { content: 'the value a_b is set' });
    rememberMemory(db, { content: 'the value axb is set' });
    rememberMemory(db, { content: 'coverage is 100% today' });

    // '_' is a single-character wildcard in LIKE; unescaped, 'a_b' would also
    // return the axb row.
    expect(recallMemories(db, 'a_b')).toHaveLength(1);
    expect(recallMemories(db, 'a_b')[0]?.content).toMatch(/a_b/);
    expect(recallMemories(db, '100')).toHaveLength(1);
    inner.close();
  });

  it('is not fooled by a catalog entry whose module is gone', () => {
    // The database was written by a build with FTS5 and is now open on one
    // without: `memories_fts` is still listed, and only touching it says so.
    const inner = openDriver(':memory:');
    migrate(inner);
    rememberMemory(inner, { content: 'written while the index still worked' });

    const catalogRow = "SELECT name FROM sqlite_master WHERE name = 'memories_fts'";
    const stale = withoutFts5(inner);
    expect(stale.get(catalogRow)).toBeDefined();
    expect(searchIndexReady(stale)).toBe(false);

    // Reads degrade and writes keep working — neither depends on the index.
    expect(recallMemories(stale, 'index')).toHaveLength(1);
    expect(() => rememberMemory(stale, { content: 'and another one after' })).not.toThrow();
    inner.close();
  });

  it('demotes itself to LIKE if the index breaks after the probe passed', () => {
    const db = fresh();
    seed(db);
    expect(searchIndexReady(db)).toBe(true);

    // Whatever makes MATCH fail once will make it fail again; recall has to
    // answer the question anyway.
    db.exec('DROP TABLE memories_fts');
    expect(recallMemories(db, 'vault')[0]?.content).toMatch(/deploy key/);
    expect(searchIndexReady(db)).toBe(false);
    db.close();
  });

  it('picks the index up and backfills it when FTS5 becomes available', () => {
    const inner = openDriver(':memory:');
    const blocked = withoutFts5(inner);
    migrate(blocked);
    rememberMemory(blocked, { content: 'written while the index was missing' });

    // Same database, a driver that can see fts5 — the shape of an install that
    // moved to a runtime with FTS5 compiled in.
    expect(searchIndexReady(inner)).toBe(true);
    expect(recallMemories(inner, 'missing')).toHaveLength(1);
    inner.close();
  });
});

describe('Remember / Recall tools', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-memory-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it('stores a note and finds it again', async () => {
    const stored = await rememberTool.execute({
      content: 'the release train leaves on Fridays',
      tags: ['release'],
    });
    expect(stored.isError).toBe(false);
    expect(stored.output).toMatch(/remembered #1 · tags: release/);

    const found = await recallTool.execute({ query: 'release train' });
    expect(found.isError).toBe(false);
    expect(found.output).toMatch(/1 memories for "release train"/);
    expect(found.output).toMatch(/leaves on Fridays/);
  });

  it('rejects empty content without writing anything', async () => {
    const r = await rememberTool.execute({ content: '   ' });
    expect(r.isError).toBe(true);
    const found = await recallTool.execute({ query: 'anything' });
    expect(found.output).toMatch(/no memories match/);
  });

  it('falls back to the most recent notes when the query has no terms', async () => {
    await rememberTool.execute({ content: 'first note' });
    await rememberTool.execute({ content: 'second note' });
    const r = await recallTool.execute({ query: '   ' });
    expect(r.output).toMatch(/2 most recent memories/);
    expect(r.output).toMatch(/second note/);
  });

  it('reports a miss rather than erroring', async () => {
    await rememberTool.execute({ content: 'a note about nothing' });
    const r = await recallTool.execute({ query: 'quantum' });
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/no memories match "quantum"/);
  });
});
