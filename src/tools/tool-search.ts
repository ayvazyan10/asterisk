// ToolSearch — the discovery half of deferred tool schemas (see deferred.ts).
//
// It returns *definitions*, not a menu. A name and a one-line description are
// not enough to call anything, so every match comes back as the same
// {name, description, input_schema} object the provider would have been sent,
// one compact JSON per line. The match is also marked loaded for the session,
// which is what makes it callable: from the next request onward its schema
// travels in the `tools` array like any other tool.
//
// Gating is untouched. The search runs over `listTools()`, so plan mode still
// hides mutating tools from it, and a loaded tool goes through exactly the
// permission checks it always did when the model finally calls it.

import { revealTool } from './deferred.ts';
import { listTools } from './registry.ts';
import type { Tool } from './types.ts';
import { err, ok } from './types.ts';

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 20;
// Kept under agent/output-store.ts's 8192-byte persist threshold: a result
// that gets spilled to disk would hand the model a file path where it asked
// for a schema.
const MAX_RESULT_BYTES = 6000;

export const toolSearchTool: Tool = {
  name: 'ToolSearch',
  description:
    'Load tools that are not listed in this request. Returns one JSON tool definition per line — name, description and input_schema — and makes each returned tool callable from your next message onwards. Search by keyword ("notion page", "github issue", "browser click"), or pass "select:<exact name>[,<name>…]" when you already know the name. A term prefixed with + must appear in the tool name.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Keywords to search for, or "select:Name1,Name2" to load specific tools by exact name.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum tools to return (default 5, max 20).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input) {
    const raw = typeof input['query'] === 'string' ? input['query'].trim() : '';
    if (!raw) return err('query is required');
    const max = clampMax(input['maxResults']);

    const tools = listTools();
    const matches = raw.toLowerCase().startsWith('select:')
      ? selectByName(tools, raw.slice('select:'.length))
      : rankByKeyword(tools, raw.toLowerCase()).slice(0, max);

    if (matches.length === 0) return ok('no tools matched the query');
    return ok(renderDefinitions(matches));
  },
};

function clampMax(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(Math.trunc(value), MAX_MAX_RESULTS));
}

/** Exact-name form. Deterministic, and the cheapest way back to a known tool. */
function selectByName(tools: readonly Tool[], list: string): Tool[] {
  const wanted = list
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return tools.filter((t) => wanted.includes(t.name.toLowerCase()));
}

function rankByKeyword(tools: readonly Tool[], query: string): Tool[] {
  const terms = query.split(/\s+/).filter(Boolean);
  const required = terms.filter((t) => t.startsWith('+')).map((t) => t.slice(1));
  const optional = terms.filter((t) => !t.startsWith('+'));

  const scored = tools.map((tool) => ({ tool, score: scoreTool(tool, required, optional) }));
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map((s) => s.tool);
}

function scoreTool(tool: Tool, required: readonly string[], optional: readonly string[]): number {
  const name = tool.name.toLowerCase();
  for (const term of required) {
    if (!name.includes(term)) return 0;
  }
  const haystack = `${name} ${tool.description.toLowerCase()}`;
  let score = required.length * 5;
  for (const term of optional) {
    if (name === term) score += 10;
    else if (name.includes(term)) score += 5;
    else if (haystack.includes(term)) score += 2;
  }
  return score;
}

/**
 * One JSON definition per line, marking each as loaded as it goes.
 *
 * Budgeted rather than truncated mid-object: half a schema is worse than a
 * missing one, and a tool that did not fit was never marked loaded, so a
 * narrower query genuinely retries it.
 */
function renderDefinitions(matches: readonly Tool[]): string {
  const lines: string[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const tool of matches) {
    const line = JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    });
    if (lines.length > 0 && bytes + line.length > MAX_RESULT_BYTES) {
      dropped++;
      continue;
    }
    revealTool(tool.name);
    lines.push(line);
    bytes += line.length + 1;
  }
  if (dropped > 0) {
    lines.push(`(${dropped} further match(es) omitted — narrow the query or use select:<name>)`);
  }
  return lines.join('\n');
}
