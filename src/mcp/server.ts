// Asterisk as an MCP *server* — the mirror image of client.ts, which connects
// Asterisk to other people's servers. This is the side that lets Claude Code,
// Zed, or anything else speaking MCP connect to Asterisk and use what it knows.
//
// Three surfaces, each chosen because it is something the connecting agent
// cannot get anywhere else:
//
//   tools     — Asterisk's durable memory (remember / recall / forget). One
//               store shared by every channel of an install, which is the
//               whole point: a note taken during a Telegram turn is findable
//               from an editor session a week later, and a note an editor
//               leaves here is what the REPL recalls tomorrow.
//   prompts   — skills. A skill in Asterisk *is* a named, described prompt
//               body, which is exactly what an MCP prompt is, so the two map
//               onto each other without inventing anything.
//   resources — rules. Standing context documents rather than templates, so
//               they belong on the resource surface, not the prompt one.
//
// What is deliberately NOT here, and should not be added:
//
//   Bash, Write, Edit. Their safety rests on a consent prompt (bash-gate.ts)
//   or on a workspace bound rooted at the process cwd. Behind an MCP server
//   the prompt has nobody to ask — an unattended run answers from
//   `permissions.headless`, so a user who set that to `allow`, or set the mode
//   to `unrestricted`, would be handing a shell to every client that connects.
//   The workspace bound fails differently and worse: the *client* chooses the
//   directory it spawns this server in, so it would be picking its own
//   boundary. Exposing these would not weaken the gate, it would route around
//   it, which is why the answer is "not exposed" rather than "exposed with a
//   stricter default".
//
//   A general `ask_asterisk` tool that runs a whole agent turn. The same
//   objection one level up: an agent turn can call Bash, so it inherits every
//   problem above and adds a model deciding when to pull the trigger.
//
//   Read, Grep, Glob. Not dangerous, just worse than useless: every MCP client
//   already has file tools bounded by its own approval policy, and proxying
//   reads through Asterisk would launder them past that policy for no gain.
//
// So everything registered below is either a read, or a bounded write of one
// row into one SQLite table. No tool here takes a path, a command or a URL.
//
// Reference: https://github.com/modelcontextprotocol/typescript-sdk

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

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
import type { Rule } from '../rules/loader.ts';
import { loadRules } from '../rules/loader.ts';
import { loadSkills } from '../skills/loader.ts';
import { getVersion } from '../version.ts';

/** Matches the cap the local Remember tool enforces: long enough for a
 *  paragraph of context, short enough that a client writes notes instead of
 *  pasting a file it should have re-read. */
const MAX_CONTENT = 4000;
/** store.ts clamps to this internally; declaring it in the schema means an
 *  over-large limit comes back as a validation error rather than silently
 *  meaning something else. */
const MAX_RESULTS = 50;
const MAX_TAGS = 16;
/** A client name is displayed in `/memory` listings, so it is length-capped. */
const MAX_SOURCE_LABEL = 40;

const RULE_URI_TEMPLATE = 'asterisk://rules/{scope}/{layer}/{name}';

export interface AsteriskMcpServerOptions {
  /**
   * Whether memory can be written and deleted. Default true.
   *
   * The escape hatch for handing a memory feed to a client the user does not
   * want writing to it: false registers `recall` alone, so `remember` and
   * `forget` are not merely refused at call time, they are absent from
   * tools/list and the connected model never learns they existed.
   */
  writable?: boolean;
  /** Project root for resolving project-local skills and rules. */
  cwd?: string;
}

export function createAsteriskMcpServer(options: AsteriskMcpServerOptions = {}): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const writable = options.writable ?? true;

  const server = new McpServer(
    { name: 'asterisk', version: getVersion() },
    { instructions: instructions(writable) },
  );

  registerMemoryTools(server, writable);
  registerSkillPrompts(server, cwd);
  registerRuleResources(server, cwd);

  return server;
}

function instructions(writable: boolean): string {
  const write = writable
    ? 'Notes you save here are what Asterisk itself recalls later.'
    : 'This connection is read-only: memory can be searched, not written or deleted.';
  return [
    "Asterisk's long-term memory, skills and rules.",
    '',
    'The memory tools read one note store shared by every channel of this Asterisk',
    `install — its terminal REPL, its chat bridges, and this connection. ${write}`,
    'Prompts are Asterisk skills. Resources are the rule files Asterisk loads into its',
    'own system prompt.',
    '',
    'There is deliberately no shell, filesystem or run-a-turn tool here: the consent',
    'gate guarding those asks a human at the Asterisk end, and over this connection',
    'there is no such human to ask.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function registerMemoryTools(server: McpServer, writable: boolean): void {
  // Unprefixed names on purpose. They match Asterisk's own tool names, so the
  // two surfaces read the same way, and every client that ships a directory of
  // servers already namespaces by server (Claude Code calls this one
  // `mcp__asterisk__recall`).
  server.registerTool(
    'recall',
    {
      title: 'Search Asterisk memory',
      description:
        'Search Asterisk long-term memory for notes saved earlier, in any session and by any ' +
        'channel of this install. Plain keywords work best — the query is matched as text, not ' +
        'as a boolean expression. Returns the most recent notes when the query has nothing ' +
        'searchable in it.',
      inputSchema: {
        query: z.string().describe('Keywords to look for in note text and tags.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .optional()
          .describe('Maximum notes to return. Default 10.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, limit }) =>
      guarded('search memory', () => {
        const db = getDb();
        // A query with nothing searchable in it — empty, or nothing but
        // punctuation — is far more likely to be "what do you know?" than a
        // genuine miss, so answer that instead of returning nothing.
        const searchable = queryTerms(query).length > 0;
        const results = searchable ? recallMemories(db, query, limit) : recentMemories(db, limit);
        if (results.length === 0) return text(`no memories match "${query}"`);

        const header = searchable
          ? `${results.length} memories for "${query}":`
          : `${results.length} most recent memories:`;
        const lines = [header, '', ...results.map(formatMemory)];
        // Worth saying out loud: unranked substring matching explains why an
        // obvious hit might be missing or badly ordered.
        if (!searchIndexReady(db)) lines.push('', '(fts5 unavailable — substring search)');
        return text(lines.join('\n'));
      }),
  );

  if (!writable) return;

  server.registerTool(
    'remember',
    {
      title: 'Save to Asterisk memory',
      description:
        'Save a note to Asterisk long-term memory. Notes persist across sessions and restarts ' +
        'and are visible to every channel of this install. Use for durable facts: preferences, ' +
        'conventions, decisions and their reasons. Do not use for a task list or for anything ' +
        'that can be re-read from a file. Search it back with recall.',
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(MAX_CONTENT)
          .describe('The note, written so it still makes sense months later without context.'),
        tags: z
          .array(z.string())
          .max(MAX_TAGS)
          .optional()
          .describe('Optional lowercase keywords to help find this later, e.g. ["deploy","ci"].'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ content, tags }) =>
      guarded('store memory', () => {
        // min(1) passes on whitespace, and the store rejects a blank note by
        // throwing — a clear message beats a caught exception.
        const trimmed = content.trim();
        if (!trimmed) return failure('content is required');

        const stored = rememberMemory(getDb(), {
          content: trimmed,
          tags: tags ?? [],
          source: memorySource(server),
        });
        const shown = stored.tags.length > 0 ? ` · tags: ${stored.tags.join(' ')}` : '';
        return text(`remembered #${stored.id}${shown}`);
      }),
  );

  server.registerTool(
    'forget',
    {
      title: 'Delete one Asterisk memory',
      description:
        'Delete one note from Asterisk long-term memory by its id. Ids come from recall, so ' +
        'recall first and quote the id you mean — there is no delete-by-search, because a fuzzy ' +
        'match is a bad thing to hand a delete.',
      inputSchema: {
        id: z.number().int().positive().describe('Id of the note to delete, as shown by recall.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    ({ id }) =>
      guarded('forget memory', () => {
        const db = getDb();
        // Read it back first so the confirmation says what actually went, not
        // what the caller believed it was deleting.
        const existing = getMemory(db, id);
        if (!existing) return failure(`no memory with id ${id}`);
        forgetMemory(db, id);
        return text(`forgot #${id}: ${existing.content.slice(0, 120)}`);
      }),
  );
}

/**
 * The `source` recorded against notes written over this connection.
 *
 * store.ts names `source` as the column to filter on when callers need telling
 * apart, and `/memory` shows it, so a note dropped in by a remote agent must
 * not look like one the user's own REPL wrote. The client's self-reported name
 * is untrusted text: it is bound as a parameter so it can never reach the SQL,
 * but it is still reduced to a safe character set and capped, because it ends
 * up on a one-line listing where a newline or a control character would let a
 * remote client forge an entry.
 */
function memorySource(server: McpServer): string {
  const raw = server.server.getClientVersion()?.name ?? '';
  const clean = raw
    .replace(/[^\w.@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SOURCE_LABEL);
  return clean ? `mcp:${clean}` : 'mcp';
}

function formatMemory(m: MemoryRecord): string {
  const when = new Date(m.createdAt).toISOString().slice(0, 10);
  const tags = m.tags.length > 0 ? ` [${m.tags.join(' ')}]` : '';
  return `#${m.id}  ${when}  ${m.source}${tags}\n    ${m.content}`;
}

// ---------------------------------------------------------------------------
// Skills → prompts
// ---------------------------------------------------------------------------

function registerSkillPrompts(server: McpServer, cwd: string): void {
  for (const skill of loadSkills(cwd)) {
    server.registerPrompt(
      skill.name,
      {
        title: skill.name,
        description: skill.description || `Asterisk ${skill.scope} skill`,
      },
      () => {
        // Re-read rather than closing over the body loaded at startup: a
        // SKILL.md edited while an editor session is open should take effect
        // on its next use. Only the *list* is a startup snapshot, and that is
        // the half clients cache anyway.
        const current = loadSkills(cwd).find((s) => s.name === skill.name);
        // Throwing is the honest protocol answer for a prompt that has gone
        // away — the SDK turns it into a JSON-RPC error, where returning an
        // apology as the prompt body would be handed to a model as if it were
        // the skill.
        if (!current) throw new Error(`skill "${skill.name}" is no longer installed`);
        return {
          description: current.description,
          messages: [
            { role: 'user' as const, content: { type: 'text' as const, text: current.prompt } },
          ],
        };
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Rules → resources
// ---------------------------------------------------------------------------

/** Scope and layer are part of the URI because the same file name legitimately
 *  appears in several of them — user/common/style.md and project/common/
 *  style.md are different rules. */
function ruleUri(rule: Rule): string {
  const name = encodeURIComponent(rule.name);
  return `asterisk://rules/${rule.scope}/${rule.layer ?? 'flat'}/${name}`;
}

function registerRuleResources(server: McpServer, cwd: string): void {
  server.registerResource(
    'rules',
    new ResourceTemplate(RULE_URI_TEMPLATE, {
      list: () => ({
        resources: loadRules(cwd).map((rule) => ({
          uri: ruleUri(rule),
          name: `${rule.scope}/${rule.layer ?? 'flat'}/${rule.name}`,
          description: `Asterisk rule loaded from ${rule.path}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Asterisk rules',
      description: 'Standing instructions Asterisk loads into its own system prompt.',
      mimeType: 'text/markdown',
    },
    (uri) => {
      // The requested URI selects from the list loadRules just produced; it is
      // never joined onto a directory. That is what makes
      // `asterisk://rules/user/flat/..%2F..%2Fetc%2Fpasswd` a miss rather than
      // a file read — there is no code path here that turns a client-supplied
      // string into a filename. Re-reading also keeps an edited rule fresh.
      const rule = loadRules(cwd).find((r) => ruleUri(r) === uri.href);
      if (!rule) throw new Error(`no such rule: ${uri.href}`);
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: rule.content }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function failure(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }], isError: true };
}

/**
 * Runs a tool body, turning a thrown database error into a tool error rather
 * than a protocol error. The caller can react to the first — retry, tell the
 * user, carry on — and can only give up on the second.
 */
function guarded(what: string, body: () => CallToolResult): CallToolResult {
  try {
    return body();
  } catch (e) {
    return failure(`could not ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
