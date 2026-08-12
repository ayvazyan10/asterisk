// Asterisk's MCP *server* surface — what another agent gets when it connects.
//
// Driven through the SDK's in-memory transport with a real SDK Client on the
// other end, not by spawning `asterisk mcp-server`. That keeps the protocol
// honest — every request goes through the same validation, capability and
// error handling the stdio transport would use — while leaving nothing to a
// process's startup timing. The entrypoint it skips is twelve lines of
// transport with no branches in it.
//
// The first test is the load-bearing one: it pins the tool list. Bash, Write
// and Edit behind an MCP server would hand a remote client the permission
// boundary's own bypass, because the gate prompts a human who is not there, so
// "these three tools and no others" is the invariant, not an inventory.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { closeDb } from '../src/db/index.ts';
import { type AsteriskMcpServerOptions, createAsteriskMcpServer } from '../src/mcp/server.ts';

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-mcp-server-'));
  for (const key of ['ASTERISK_HOME', 'ASTERISK_LANG']) saved[key] = process.env[key];
  process.env['ASTERISK_HOME'] = home;
  // Rule discovery is language-aware; an inherited ASTERISK_LANG would change
  // which directories are scanned and make these assertions machine-specific.
  delete process.env['ASTERISK_LANG'];
});

afterEach(async () => {
  closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

interface Connection {
  client: Client;
  close(): Promise<void>;
}

async function connect(options: AsteriskMcpServerOptions = {}): Promise<Connection> {
  // cwd is the temp home so project-local skills and rules cannot be picked up
  // from whatever directory the test runner happens to sit in.
  const server = createAsteriskMcpServer({ cwd: home, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('\n');
}

async function writeSkill(name: string, description: string, body: string): Promise<string> {
  const dir = join(home, 'skills', name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return file;
}

async function writeRule(name: string, body: string): Promise<string> {
  const dir = join(home, 'rules', 'common');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, body);
  return file;
}

describe('tool surface', () => {
  it('exposes memory and nothing that runs a command or touches a file', async () => {
    const c = await connect();
    const names = (await c.client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual(['forget', 'recall', 'remember']);
    // Named individually so a future re-export fails with the offender in the
    // message rather than as a diff of two sorted arrays.
    for (const banned of ['Bash', 'Write', 'Edit', 'Read', 'Grep', 'Glob', 'ask_asterisk']) {
      expect(names).not.toContain(banned);
    }
    await c.close();
  });

  it('describes itself as memory-and-no-shell in its instructions', async () => {
    const c = await connect();
    // The instructions reach the connecting model, so the boundary is stated
    // in-band as well as in the tool list.
    expect(c.client.getInstructions()).toMatch(/no shell, filesystem or run-a-turn tool/);
    await c.close();
  });

  it('read-only mode leaves the writing tools out of the list entirely', async () => {
    const c = await connect({ writable: false });
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['recall']);

    // Absent, not merely refused: the model never learns the verb exists.
    const attempt = await c.client.callTool({ name: 'remember', arguments: { content: 'x' } });
    expect(attempt.isError).toBe(true);
    expect(textOf(attempt)).toMatch(/remember/);
    await c.close();
  });
});

describe('memory', () => {
  it('round-trips a note and records which client wrote it', async () => {
    const c = await connect();
    const stored = await c.client.callTool({
      name: 'remember',
      arguments: { content: 'the deploy key lives in the vault', tags: ['ops', 'deploy'] },
    });
    expect(textOf(stored)).toMatch(/remembered #\d+ · tags: ops deploy/);

    const found = await c.client.callTool({ name: 'recall', arguments: { query: 'deploy key' } });
    expect(textOf(found)).toMatch(/the deploy key lives in the vault/);
    // Provenance: a note left by a connected agent must not read as one the
    // user's own REPL wrote.
    expect(textOf(found)).toMatch(/mcp:test-client/);
    await c.close();
  });

  it('answers a query with nothing searchable in it with the recent notes', async () => {
    const c = await connect();
    await c.client.callTool({ name: 'remember', arguments: { content: 'first note' } });
    await c.client.callTool({ name: 'remember', arguments: { content: 'second note' } });

    const found = await c.client.callTool({ name: 'recall', arguments: { query: '   ' } });
    expect(textOf(found)).toMatch(/2 most recent memories/);
    expect(textOf(found)).toMatch(/second note/);
    await c.close();
  });

  it('survives a query that would be a syntax error as raw FTS5', async () => {
    const c = await connect();
    await c.client.callTool({
      name: 'remember',
      arguments: { content: 'a note about deploy and rollback' },
    });
    // A bare `"` is a hard syntax error to FTS5 and AND is a reserved word;
    // the store sanitises both into literal terms, so this is a search rather
    // than a failed turn or a boolean expression nobody asked for.
    const found = await c.client.callTool({ name: 'recall', arguments: { query: 'deploy" AND' } });
    expect(found.isError).toBeFalsy();
    expect(textOf(found)).toMatch(/a note about deploy and rollback/);
    await c.close();
  });

  it('forgets the one id it was given and says what went', async () => {
    const c = await connect();
    const first = await c.client.callTool({ name: 'remember', arguments: { content: 'note one' } });
    await c.client.callTool({ name: 'remember', arguments: { content: 'note two' } });
    const id = Number(/#(\d+)/.exec(textOf(first))?.[1]);

    const gone = await c.client.callTool({ name: 'forget', arguments: { id } });
    expect(textOf(gone)).toBe(`forgot #${id}: note one`);

    const left = await c.client.callTool({ name: 'recall', arguments: { query: 'note' } });
    expect(textOf(left)).toMatch(/note two/);
    expect(textOf(left)).not.toMatch(/note one/);
    await c.close();
  });

  it('reports an unknown id instead of claiming a delete', async () => {
    const c = await connect();
    const missing = await c.client.callTool({ name: 'forget', arguments: { id: 4321 } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('no memory with id 4321');
    await c.close();
  });

  it('refuses a note past the content cap rather than storing a file dump', async () => {
    const c = await connect();
    const huge = await c.client.callTool({
      name: 'remember',
      arguments: { content: 'x'.repeat(4001) },
    });
    expect(huge.isError).toBe(true);

    const nothing = await c.client.callTool({ name: 'recall', arguments: { query: 'xxxx' } });
    expect(textOf(nothing)).toMatch(/no memories match/);
    await c.close();
  });

  it('refuses a blank note that got past the schema on whitespace', async () => {
    const c = await connect();
    const blank = await c.client.callTool({ name: 'remember', arguments: { content: '   \n  ' } });
    expect(blank.isError).toBe(true);
    expect(textOf(blank)).toBe('content is required');
    await c.close();
  });
});

describe('skills as prompts', () => {
  it('offers a skill as a prompt and returns its body', async () => {
    await writeSkill('ship-check', 'Run the pre-ship checklist.', 'Typecheck, then test.');
    const c = await connect();

    const listed = (await c.client.listPrompts()).prompts.find((p) => p.name === 'ship-check');
    expect(listed?.description).toBe('Run the pre-ship checklist.');

    const got = await c.client.getPrompt({ name: 'ship-check' });
    expect(got.messages[0]?.role).toBe('user');
    expect(got.messages[0]?.content).toMatchObject({ type: 'text', text: 'Typecheck, then test.' });
    await c.close();
  });

  it('reads the skill body at call time, not at startup', async () => {
    await writeSkill('ship-check', 'Run the pre-ship checklist.', 'Old body.');
    const c = await connect();
    await writeSkill('ship-check', 'Run the pre-ship checklist.', 'New body.');

    const got = await c.client.getPrompt({ name: 'ship-check' });
    expect(got.messages[0]?.content).toMatchObject({ text: 'New body.' });
    await c.close();
  });

  it('errors rather than answering with an apology when a skill is gone', async () => {
    const file = await writeSkill('ship-check', 'Run it.', 'Typecheck, then test.');
    const c = await connect();
    await rm(file);

    // An apology returned as the prompt body would be handed to a model as if
    // it were the skill; a protocol error cannot be mistaken for one.
    await expect(c.client.getPrompt({ name: 'ship-check' })).rejects.toThrow(/no longer installed/);
    await c.close();
  });
});

describe('rules as resources', () => {
  it('lists and reads a rule file', async () => {
    await writeRule('style.md', '# Style\nTabs over spaces.');
    const c = await connect();

    const listed = (await c.client.listResources()).resources;
    const rule = listed.find((r) => r.name === 'user/common/style.md');
    expect(rule?.uri).toBe('asterisk://rules/user/common/style.md');
    expect(rule?.mimeType).toBe('text/markdown');

    const read = await c.client.readResource({ uri: 'asterisk://rules/user/common/style.md' });
    // toMatchObject rather than a property read: contents is a text-or-blob
    // union, and asserting the whole block is what pins it to the text arm.
    expect(read.contents[0]).toMatchObject({
      uri: 'asterisk://rules/user/common/style.md',
      mimeType: 'text/markdown',
      text: '# Style\nTabs over spaces.',
    });
    await c.close();
  });

  it('does not turn a resource URI into a file path', async () => {
    await writeRule('style.md', 'Tabs over spaces.');
    const secret = join(home, 'secret.md');
    await writeFile(secret, 'DO NOT SERVE THIS');
    const c = await connect();

    // Both shapes match the URI template, so both reach the read handler. It
    // resolves by exact match against the rules loadRules just found, so
    // neither can name a file that is not one of them.
    // The second one is placed to be reachable: an implementation that joined
    // the URI's last segment onto ~/.asterisk/rules/common would serve
    // secret.md, so this is a leak the assertion can actually witness.
    for (const uri of [
      'asterisk://rules/user/common/..%2F..%2Fetc%2Fpasswd',
      `asterisk://rules/user/common/${encodeURIComponent('../../secret.md')}`,
    ]) {
      await expect(c.client.readResource({ uri })).rejects.toThrow(/no such rule/);
    }
    await c.close();
  });

  it('reads the rule from disk at call time', async () => {
    await writeRule('style.md', 'Old rule.');
    const c = await connect();
    await writeRule('style.md', 'New rule.');

    const read = await c.client.readResource({ uri: 'asterisk://rules/user/common/style.md' });
    expect(read.contents[0]).toMatchObject({ text: 'New rule.' });
    await c.close();
  });
});
