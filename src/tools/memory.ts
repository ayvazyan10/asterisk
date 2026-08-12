// Remember / Recall — the agent's long-term memory.
//
// Distinct from the task list and from conversation history: both of those are
// per-session and both eventually go away, whereas anything written here
// survives compaction, restarts and the session itself. Storage and search
// live in src/memory/store.ts; this file is only the model-facing surface.

import { currentSession } from '../agent/context.ts';
import { getDb } from '../db/index.ts';
import {
  type MemoryRecord,
  forgetMemory,
  getMemory,
  queryTerms,
  recallMemories,
  recentMemories,
  rememberMemory,
  searchIndexReady,
} from '../memory/store.ts';
import { type Tool, err, ok } from './types.ts';

/** Long enough for a paragraph of context, short enough that the model writes
 *  notes rather than dumping a file it should have re-read instead. */
const MAX_CONTENT = 4000;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

function fmtMemory(m: MemoryRecord): string {
  const when = new Date(m.createdAt).toISOString().slice(0, 10);
  const tags = m.tags.length > 0 ? ` [${m.tags.join(' ')}]` : '';
  return `#${m.id}  ${when}  ${m.source}${tags}\n    ${m.content}`;
}

export const rememberTool: Tool = {
  name: 'Remember',
  description:
    'Save a note to long-term memory. Memories persist across sessions and restarts, and are ' +
    'shared by every channel of this Asterisk install. Use for durable facts: user preferences, ' +
    'project conventions, decisions and their reasons. Do not use for the current task list or ' +
    'for anything you can re-read from a file. Search it back with Recall.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The note, written so it still makes sense months later without context.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional lowercase keywords to help find this later, e.g. ["deploy","ci"].',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },
  async execute(input) {
    const raw = typeof input['content'] === 'string' ? input['content'].trim() : '';
    if (!raw) return err('content is required');
    if (raw.length > MAX_CONTENT) {
      return err(`content is ${raw.length} chars; keep memories under ${MAX_CONTENT}`);
    }

    try {
      const stored = rememberMemory(getDb(), {
        content: raw,
        tags: asStringArray(input['tags']),
        // The channel, not the chat id: memory is install-wide, and a chat id
        // would put a phone number in a column nothing filters on.
        source: currentSession().scope,
      });
      const tags = stored.tags.length > 0 ? ` · tags: ${stored.tags.join(' ')}` : '';
      return ok(`remembered #${stored.id}${tags}`);
    } catch (e) {
      return err(`could not store memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const recallTool: Tool = {
  name: 'Recall',
  description:
    'Search long-term memory for notes saved earlier with Remember, in this session or any ' +
    'previous one. Plain keywords work best — the query is matched as text, not as a boolean ' +
    'expression. Returns the most recent notes when the query has nothing searchable in it.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to look for in note text and tags.' },
      limit: { type: 'number', description: 'Maximum notes to return. Default 10, max 50.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input) {
    const query = typeof input['query'] === 'string' ? input['query'] : '';
    const limit = typeof input['limit'] === 'number' ? input['limit'] : undefined;

    try {
      const db = getDb();
      // A query with no searchable term in it — an empty string, or nothing but
      // punctuation — is far more likely to be the model reaching for "what do
      // I know?" than a genuine miss, so answer that instead of returning
      // nothing. It also keeps the two callers of clampLimit consistent.
      const searchable = queryTerms(query).length > 0;
      const results = searchable ? recallMemories(db, query, limit) : recentMemories(db, limit);

      if (results.length === 0) return ok(`no memories match "${query}"`);

      const header = searchable
        ? `${results.length} memories for "${query}":`
        : `${results.length} most recent memories:`;
      const lines = [header, '', ...results.map(fmtMemory)];
      // Worth saying out loud: unranked substring matching explains why an
      // obvious hit might be missing or badly ordered.
      if (!searchIndexReady(db)) lines.push('', '(fts5 unavailable — substring search)');
      return ok(lines.join('\n'));
    } catch (e) {
      return err(`could not search memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const forgetTool: Tool = {
  name: 'Forget',
  description:
    'Delete one note from long-term memory by its id. Ids come from Recall, so recall first ' +
    'and quote the id you mean — there is no delete-by-search, because a fuzzy match is a bad ' +
    'thing to hand a delete. Use when a note has become wrong or the user asks you to forget ' +
    'something.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'number', description: 'Id of the note to delete, as shown by Recall.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(input) {
    const raw = input['id'];
    const id = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) return err('id must be a positive integer from Recall');

    try {
      const db = getDb();
      // Read it back before deleting so the confirmation says what actually
      // went, not what the model believed it was deleting.
      const existing = getMemory(db, id);
      if (!existing) return err(`no memory with id ${id}`);
      forgetMemory(db, id);
      return ok(`forgot #${id}: ${existing.content.slice(0, 120)}`);
    } catch (e) {
      return err(`could not forget memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const MEMORY_TOOLS: Tool[] = [rememberTool, recallTool, forgetTool];
