// Deferred tool schemas.
//
// The measurement that produced this feature: on a live install with Notion,
// GitHub and engram connected, 148 registered tools carried ~206KB of JSON
// schema into every single request — ~60k tokens before the user had typed a
// word, and nine to seventeen minutes of prompt-eval on a local llama.cpp.
//
// What is under test here is that the request shrinks without anything else
// moving: the same tools stay dispatchable, allowedTools still means what it
// meant, and a tool the model loads mid-conversation becomes callable through
// the normal channel rather than through some side door.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { saveConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import {
  CORE_TOOL_NAMES,
  type DeferMode,
  clearRevealedTools,
  deferredPointer,
} from '../src/tools/deferred.ts';
import { promptToolDefinitions, setExtraTools, toolDefinitions } from '../src/tools/registry.ts';
import { toolSearchTool } from '../src/tools/tool-search.ts';
import type { Tool } from '../src/tools/types.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/types/messages.ts';

// ─── harness ───────────────────────────────────────────────────────────

let home = '';
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'asterisk-defer-'));
  savedHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
});

afterEach(() => {
  setExtraTools([]);
  clearRevealedTools();
  closeDb();
  if (savedHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function setMode(mode: DeferMode): void {
  const config = ConfigSchema.parse({});
  saveConfig({ ...config, tools: { deferSchemas: mode } });
}

/**
 * Stand-ins shaped like the real thing: Notion's 37 tools average 3.3KB of
 * schema apiece, so a fake with a trivial schema would understate the problem
 * by two orders of magnitude and the size test would prove nothing.
 */
function fakeMcpTools(count: number, server = 'acme'): Tool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${server}__tool_${i}`,
    description: `Fake MCP tool ${i} from ${server}. ${'Lorem ipsum dolor sit amet. '.repeat(12)}`,
    input_schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_, p) => [
          `param_${p}`,
          { type: 'string', description: `Parameter ${p}. ${'Describes a field. '.repeat(8)}` },
        ]),
      ),
      required: ['param_0'],
      additionalProperties: false,
    },
    execute: async () => ({ output: `ran ${server}__tool_${i}`, isError: false }),
  }));
}

function bytesOf(defs: readonly unknown[]): number {
  return defs.reduce<number>((sum, def) => sum + JSON.stringify(def).length, 0);
}

/** Records every tool list the loop hands the provider. */
function recordingProvider(responses: ProviderResponse[]): {
  provider: Provider;
  sent: string[][];
} {
  const sent: string[][] = [];
  let i = 0;
  const provider: Provider = {
    name: 'fake',
    async send(request: ProviderRequest) {
      sent.push(request.tools.map((t) => t.name));
      const r = responses[i++];
      if (!r) throw new Error('fake provider exhausted');
      return r;
    },
  };
  return { provider, sent };
}

// ─── prompt size ───────────────────────────────────────────────────────

describe('prompt size under deferral', () => {
  it('does not grow with the number of MCP tools', () => {
    setMode('mcp');

    setExtraTools(fakeMcpTools(10));
    const promptSmall = bytesOf(promptToolDefinitions());
    const registrySmall = bytesOf(toolDefinitions());

    setExtraTools(fakeMcpTools(200));
    const promptLarge = bytesOf(promptToolDefinitions());
    const registryLarge = bytesOf(toolDefinitions());

    // The cost being avoided: the full registry view is linear in N, and at
    // 200 tools it is well past the whole context window of a local model.
    expect(registryLarge - registrySmall).toBeGreaterThan(300_000);

    // The prompt view moves only by the pointer's own wording (a name list
    // becomes a count), never by the schemas themselves.
    expect(Math.abs(promptLarge - promptSmall)).toBeLessThan(1_500);
    expect(promptLarge).toBeLessThan(registryLarge / 10);

    // And the count is flat: exactly the built-ins, no MCP tool.
    const names = promptToolDefinitions().map((t) => t.name);
    expect(names.filter((n) => n.startsWith('acme__'))).toEqual([]);
    expect(names.length).toBe(toolDefinitions().length - 200);
  });

  it('points at what it left out, by server and count', () => {
    setMode('mcp');
    setExtraTools([...fakeMcpTools(37, 'notion'), ...fakeMcpTools(44, 'github')]);

    const search = promptToolDefinitions().find((t) => t.name === 'ToolSearch');
    expect(search?.description).toContain('81 more are available on demand');
    expect(search?.description).toContain('notion: 37 tools');
    expect(search?.description).toContain('github: 44 tools');
    expect(search?.description).toContain('ToolSearch');
  });

  it('names small groups instead of counting them', () => {
    const pointer = deferredPointer(fakeMcpTools(3, 'engram'));
    expect(pointer).toContain('engram (3): engram__tool_0, engram__tool_1, engram__tool_2');
  });

  it('all mode keeps the core working set and defers the rest', () => {
    setMode('all');
    setExtraTools([]);
    const names = promptToolDefinitions().map((t) => t.name);

    for (const core of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'ToolSearch']) {
      expect(names).toContain(core);
    }
    expect(names.sort()).toEqual([...CORE_TOOL_NAMES].sort());
    // Deferring the long tail of built-ins is worth real bytes, not a rounding
    // error — RunCode and the eight browser tools alone are ~6KB.
    expect(bytesOf(promptToolDefinitions())).toBeLessThan(bytesOf(toolDefinitions()) / 2);

    // The system prompt names the browser tools by hand, so a pointer that only
    // said "built-in: 27 tools" would leave the model reading about tools it
    // cannot see and cannot guess a query for. Built-ins are spelled out.
    const search = promptToolDefinitions().find((t) => t.name === 'ToolSearch');
    expect(search?.description).toContain('BrowserNavigate');
    expect(search?.description).toContain('RunCode');
    expect(search?.description).toContain('Remember');
  });

  it('spends the pointer budget on the groups in front, not all or nothing', () => {
    setMode('mcp');
    // Two mid-size servers plus a big one: the big one must not demote the
    // small ones behind it to counts.
    setExtraTools([
      ...fakeMcpTools(4, 'small'),
      ...fakeMcpTools(120, 'huge'),
      ...fakeMcpTools(4, 'tail'),
    ]);
    const pointer = deferredPointer([
      ...fakeMcpTools(4, 'small'),
      ...fakeMcpTools(120, 'huge'),
      ...fakeMcpTools(4, 'tail'),
    ]);
    expect(pointer).toContain('small (4): small__tool_0');
    expect(pointer).toContain('huge: 120 tools');
    expect(pointer).toContain('tail (4): tail__tool_0');
  });
});

// ─── the off switch ────────────────────────────────────────────────────

describe('deferSchemas: off', () => {
  it('sends every schema, exactly as before', () => {
    setMode('off');
    setExtraTools(fakeMcpTools(30));

    const prompt = promptToolDefinitions();
    const registry = toolDefinitions();
    expect(prompt.map((t) => t.name)).toEqual(registry.map((t) => t.name));
    expect(bytesOf(prompt)).toBe(bytesOf(registry));

    // No pointer either: nothing was left out, so there is nothing to announce.
    const search = prompt.find((t) => t.name === 'ToolSearch');
    expect(search?.description).not.toContain('available on demand');
  });

  it('is the same list the loop sends the provider', async () => {
    setMode('off');
    setExtraTools(fakeMcpTools(30));
    const { provider, sent } = recordingProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    await runAgentTurn(provider, createAgentState(), 'hi', { summariseDropped: false });
    expect(sent[0]?.filter((n) => n.startsWith('acme__')).length).toBe(30);
  });
});

// ─── discovery, end to end ─────────────────────────────────────────────

describe('ToolSearch loads a deferred tool', () => {
  it('returns the full schema and makes the tool callable next turn', async () => {
    setMode('mcp');
    setExtraTools(fakeMcpTools(40));

    const { provider, sent } = recordingProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 's1',
            name: 'ToolSearch',
            input: { query: 'select:acme__tool_7' },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [
          { type: 'tool_use', id: 'c1', name: 'acme__tool_7', input: { param_0: 'value' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);

    const results: Array<{ name: string; output: string; isError: boolean }> = [];
    const result = await runAgentTurn(provider, createAgentState(), 'use tool 7', {
      summariseDropped: false,
      onToolResult: (name, output, isError) => results.push({ name, output, isError }),
    });

    expect(result.reason).toBe('end-turn');

    // 1. The first request did not carry the tool.
    expect(sent[0]).not.toContain('acme__tool_7');
    // 2. ToolSearch answered with a definition the model can actually call.
    const search = results.find((r) => r.name === 'ToolSearch');
    expect(search?.isError).toBe(false);
    const definition = JSON.parse(search?.output ?? '{}');
    expect(definition.name).toBe('acme__tool_7');
    expect(definition.input_schema.properties.param_0).toBeDefined();
    expect(definition.input_schema.required).toEqual(['param_0']);
    // 3. From the next request onward it travels in the tools array, so the
    //    model calls it through the normal channel — no unknown-name tool_use.
    expect(sent[1]).toContain('acme__tool_7');
    // 4. …and the other 39 are still deferred.
    expect(sent[1]?.filter((n) => n.startsWith('acme__'))).toEqual(['acme__tool_7']);
    // 5. The call really ran.
    const call = results.find((r) => r.name === 'acme__tool_7');
    expect(call?.isError).toBe(false);
    expect(call?.output).toBe('ran acme__tool_7');
  });

  it('a deferred tool called without searching is dispatched and then listed', async () => {
    setMode('mcp');
    setExtraTools(fakeMcpTools(5));

    const { provider, sent } = recordingProvider([
      {
        content: [{ type: 'tool_use', id: 'c1', name: 'acme__tool_2', input: { param_0: 'x' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);

    await runAgentTurn(provider, createAgentState(), 'go', { summariseDropped: false });

    expect(sent[0]).not.toContain('acme__tool_2');
    // The history now references it, so the follow-up request must offer it.
    expect(sent[1]).toContain('acme__tool_2');
  });

  it('keeps its result under the size that would spill it to disk', async () => {
    setMode('mcp');
    setExtraTools(fakeMcpTools(40));
    const res = await toolSearchTool.execute({ query: 'acme', maxResults: 20 });
    expect(res.isError).toBe(false);
    // agent/output-store.ts persists anything over 8192 bytes and hands the
    // model a file path instead — which would be a path where it asked for a
    // schema. The budget has to hold even when 20 fat schemas match.
    expect(res.output.length).toBeLessThan(8192);
    expect(res.output).toContain('omitted');
  });
});

// ─── allowedTools ──────────────────────────────────────────────────────

describe('allowedTools is unaffected by deferral', () => {
  it('sends exactly the allowed list, deferral or not', async () => {
    setMode('mcp');
    setExtraTools(fakeMcpTools(50));

    const { provider, sent } = recordingProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    await runAgentTurn(provider, createAgentState(), 'research', {
      allowedTools: ['Read', 'Grep', 'Glob'],
      summariseDropped: false,
    });

    expect(sent[0]?.sort()).toEqual(['Glob', 'Grep', 'Read']);
  });

  it('still grants an MCP tool that the allow-list names', async () => {
    setMode('mcp');
    setExtraTools(fakeMcpTools(50));

    const { provider, sent } = recordingProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    await runAgentTurn(provider, createAgentState(), 'go', {
      allowedTools: ['Read', 'acme__tool_3'],
      summariseDropped: false,
    });

    expect(sent[0]?.sort()).toEqual(['Read', 'acme__tool_3']);
  });
});
