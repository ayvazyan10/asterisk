// Five defects the coverage work exposed, and the tests that keep them fixed.
//
// All five had the same shape: a branch nothing exercised, so nothing noticed
// it was wrong. Two of them silently corrupted configuration — which is worse
// than an error, because the user has no reason to look.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMANDS } from '../src/commands/registry.ts';
import { loadConfig, saveConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import type { FormSpec, ListSpec } from '../src/repl/forms/types.ts';

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-fix-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
});

afterEach(async () => {
  closeDb();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

const command = (name: string) => {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`no command ${name}`);
  return found;
};

/** A context stub; these commands only read `provider` and `mcp`. */
function ctx(providerName: string) {
  return {
    provider: {
      name: providerName,
      async send() {
        throw new Error('not used');
      },
    },
    setProvider: () => {},
    state: { history: [] },
    clearHistory: () => {},
    exit: () => {},
    mcp: {
      servers: [],
      tools: [],
      async reload() {
        return { connected: [], failed: [] };
      },
      async shutdown() {},
    },
  } as never;
}

function withProvider(provider: 'openai-compatible' | 'anthropic'): void {
  const config = ConfigSchema.parse({});
  saveConfig({ ...config, provider });
}

describe('/config provider offers every provider the schema has', () => {
  it('includes openai-compatible', async () => {
    // SelectRow clamps an out-of-options value to index 0, so omitting this
    // did not merely hide it — it moved anyone using openai-compatible onto
    // another provider as soon as they touched the arrow keys.
    const out = (await command('/config').execute(
      ctx('openai-compatible:x'),
      'provider',
    )) as FormSpec;
    const field = out.fields.find((f) => f.key === 'provider');
    const values = field && 'options' in field ? field.options.map((o) => o.value) : [];
    expect(values).toEqual(['openai-compatible', 'anthropic']);
  });

  it('round-trips the selection into config', async () => {
    const out = (await command('/config').execute(
      ctx('openai-compatible:x'),
      'provider',
    )) as FormSpec;
    await out.onSubmit({ provider: 'openai-compatible' });
    expect(loadConfig().config.provider).toBe('openai-compatible');
  });
});

describe('/model asks the right backend', () => {
  it('does not offer Anthropic models on an openai-compatible provider', async () => {
    // switchModel writes the picked id into openaiCompatible.model, keyed off
    // the *current* provider — so the Anthropic list put a Claude id into the
    // local endpoint's config.
    withProvider('openai-compatible');
    const out = await command('/model').execute(ctx('openai-compatible:gemma'), '');

    if (typeof out === 'string') {
      // No endpoint reachable in the test environment — the important part is
      // that it says so rather than falling through to another vendor's list.
      expect(out).toMatch(/could not reach/);
      expect(out).not.toMatch(/claude/i);
      return;
    }
    const items = (out as ListSpec).items.map((i) => i.value);
    expect(items.some((v) => /claude/i.test(v))).toBe(false);
  });
});

describe('/mcp edit validates like /mcp add', () => {
  async function addStdio(): Promise<void> {
    const form = (await command('/mcp').execute(
      ctx('openai-compatible:x'),
      'add stdio',
    )) as FormSpec;
    await form.onSubmit({ name: 'srv', command: 'node', args: 'server.js', enabled: 'yes' });
  }

  it('refuses a blank command with a message, not a raw ZodError', async () => {
    await addStdio();
    const form = (await command('/mcp').execute(
      ctx('openai-compatible:x'),
      'edit srv',
    )) as FormSpec;
    const result = await form.onSubmit({ command: '   ', args: '', enabled: 'yes' });

    expect(String(result)).toContain('command is required');
    expect(String(result)).not.toContain('validation');
  });

  it('refuses a url that is not http(s)', async () => {
    const add = (await command('/mcp').execute(ctx('openai-compatible:x'), 'add http')) as FormSpec;
    await add.onSubmit({ name: 'web', url: 'https://example.com/mcp', enabled: 'yes' });

    const form = (await command('/mcp').execute(
      ctx('openai-compatible:x'),
      'edit web',
    )) as FormSpec;
    const result = await form.onSubmit({ url: 'notaurl', enabled: 'yes' });

    expect(String(result)).toMatch(/http:\/\/ or https:\/\//);
    // The stored server must be untouched by a rejected edit.
    const stored = loadConfig().config.mcpServers.find((s) => s.name === 'web');
    expect(stored && 'url' in stored ? stored.url : '').toBe('https://example.com/mcp');
  });
});

describe('/code reports no matches as no matches', () => {
  it('does not report ripgrep exit 1 as a broken command', async () => {
    // rg exits 1 when nothing matched, which execSync raises — so the
    // `|| '(no matches)'` fallback was unreachable and the user saw
    // "Command failed: rg …" as though the tool were broken.
    // Built at runtime: a literal here would be found by the very search it
    // is meant to come up empty on — the file is inside the search path.
    const absent = ['zzq', 'nothing', 'matches', 'this'].join('-') + Date.now();
    const out = (await command('/code').execute(
      ctx('openai-compatible:x'),
      `refs ${absent}`,
    )) as string;

    expect(out).not.toMatch(/Command failed/);
    expect(out).toMatch(/no matches/);
  });
});
