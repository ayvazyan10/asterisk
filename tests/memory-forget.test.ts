// Deleting a memory, and the two silent ways to get it wrong.
//
// An external-content FTS5 table does not delete like a normal table, and both
// wrong ways are *silent* — no error, no exception, just an index holding terms
// for rows that no longer exist:
//
//   * `DELETE FROM memories_fts WHERE rowid = ?` removes nothing at all.
//   * the `'delete'` command given values that differ from what was indexed
//     also succeeds, and leaves the terms behind.
//
// Both were reproduced against bun:sqlite before this code was written.
//
// Two things worth stating precisely, because earlier drafts of this file got
// both wrong:
//
// The damage is not that a deleted note comes back. Recall JOINs the index to
// `memories` on rowid, so a ghost entry is filtered out. What it costs is an
// index growing without bound and bm25 rankings skewed by documents that are
// not there — visible only by querying the index directly, which is why the
// assertions below do that instead of going through recall.
//
// And the coverage is uneven, deliberately said out loud: `forgetAllMemories`
// deletes base rows first, so only the `'delete-all'` command can clean the
// index and the assertion there discriminates. `forgetMemory` touches the
// index while the row still exists, where a plain DELETE would also work — so
// its assertions pass for either implementation. The explicit command is used
// anyway so that correctness does not depend on statement order, but no test
// here proves that choice; only the comment in the store does.

import { describe, expect, it } from 'vitest';

import { openDriver } from '../src/db/driver.ts';
import { MEMORY_FTS_SQL, migrate } from '../src/db/migrations.ts';
import {
  countMemories,
  forgetAllMemories,
  forgetMemory,
  getMemory,
  recallMemories,
  rememberMemory,
  searchIndexReady,
} from '../src/memory/store.ts';

/** Rows the INDEX still matches, ignoring whether the base row survives.
 *  Recall's JOIN filters ghosts out, so this is the only way to see them. */
function indexHits(db: ReturnType<typeof openDriver>, term: string): number {
  return db.all<{ rowid: number }>('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?', [
    term,
  ]).length;
}

function fresh() {
  const db = openDriver(':memory:');
  migrate(db);
  // migrate() applies the FTS5 statement optionally; make sure it is really
  // there, otherwise these tests would pass by exercising the fallback.
  if (!searchIndexReady(db)) db.exec(MEMORY_FTS_SQL);
  return db;
}

describe('forgetMemory', () => {
  it('removes the note from both the table and the search index', () => {
    const db = fresh();
    const note = rememberMemory(db, { content: 'the vault deploy key rotates monthly' });

    expect(recallMemories(db, 'vault')).toHaveLength(1);
    expect(forgetMemory(db, note.id)).toBe(true);

    expect(recallMemories(db, 'vault')).toHaveLength(0);
    expect(getMemory(db, note.id)).toBeNull();
    expect(countMemories(db)).toBe(0);
    // The assertion that actually bites: the term must be gone from the index
    // itself. Recall's JOIN hides a ghost entry, so checking recall alone would
    // pass against a plain DELETE that removes nothing.
    expect(indexHits(db, 'vault')).toBe(0);
  });

  it('leaves other notes searchable', () => {
    const db = fresh();
    const gone = rememberMemory(db, { content: 'vault key rotates monthly' });
    rememberMemory(db, { content: 'vault address is on the intranet' });

    forgetMemory(db, gone.id);

    const left = recallMemories(db, 'vault');
    expect(left).toHaveLength(1);
    expect(left[0]?.content).toContain('intranet');
  });

  it('un-indexes by tag as well as content', () => {
    const db = fresh();
    const note = rememberMemory(db, { content: 'rotate it', tags: ['ops', 'secrets'] });
    expect(indexHits(db, 'secrets')).toBe(1);

    forgetMemory(db, note.id);
    expect(indexHits(db, 'secrets')).toBe(0);
  });

  it('reports false for an id that was never there', () => {
    const db = fresh();
    expect(forgetMemory(db, 9999)).toBe(false);
  });

  it('is idempotent', () => {
    const db = fresh();
    const note = rememberMemory(db, { content: 'once' });
    expect(forgetMemory(db, note.id)).toBe(true);
    expect(forgetMemory(db, note.id)).toBe(false);
  });

  it('works on a build with no search index', () => {
    // The fallback path has no index to keep in step, but must not throw on
    // the code that would otherwise touch it.
    const db = openDriver(':memory:');
    migrate(db);
    db.exec('DROP TABLE IF EXISTS memories_fts');
    const note = rememberMemory(db, { content: 'no index here' });
    expect(forgetMemory(db, note.id)).toBe(true);
    expect(countMemories(db)).toBe(0);
  });
});

describe('forgetAllMemories', () => {
  it('empties both the table and the index, and reports how many went', () => {
    const db = fresh();
    rememberMemory(db, { content: 'first vault note' });
    rememberMemory(db, { content: 'second vault note' });

    expect(forgetAllMemories(db)).toBe(2);
    expect(countMemories(db)).toBe(0);
    // 'delete-all' is the index's own reset; dropping base rows alone leaves
    // every term still in the index, which only a direct query can see.
    expect(indexHits(db, 'vault')).toBe(0);
  });

  it('leaves the store usable afterwards', () => {
    const db = fresh();
    rememberMemory(db, { content: 'old' });
    forgetAllMemories(db);

    const fresh2 = rememberMemory(db, { content: 'new vault note' });
    expect(recallMemories(db, 'vault').map((m) => m.id)).toEqual([fresh2.id]);
  });

  it('returns zero on an empty store', () => {
    expect(forgetAllMemories(fresh())).toBe(0);
  });
});

describe('Forget tool', () => {
  it('refuses an id that is not a positive integer', async () => {
    const { forgetTool } = await import('../src/tools/memory.ts');
    for (const id of [0, -1, 1.5, 'x', undefined]) {
      const r = await forgetTool.execute({ id } as Record<string, unknown>);
      expect(r.isError).toBe(true);
    }
  });

  it('takes only an id, never a search query', async () => {
    // Handing a fuzzy match to a delete is how the wrong note disappears.
    const { forgetTool } = await import('../src/tools/memory.ts');
    expect(Object.keys(forgetTool.input_schema.properties)).toEqual(['id']);
    expect(forgetTool.input_schema.required).toEqual(['id']);
  });

  it('names what it deleted, read back from the row rather than assumed', async () => {
    const { forgetTool } = await import('../src/tools/memory.ts');
    // Executed against the real database path, so this only asserts the
    // failure branch; the success branch is covered by forgetMemory above.
    const r = await forgetTool.execute({ id: 987654321 });
    expect(r.isError).toBe(true);
    expect(r.output).toContain('987654321');
  });
});
