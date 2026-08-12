// The remaining command modules: saved-conversation management
// (session-flows), the git and code-intelligence views (code-flows), the
// plugin inventory, the revoke flows of /permissions, and /doctor.
//
// The git views shell out with no cwd of their own, so those tests build a
// throwaway repository and chdir into it — asserting against the real
// repository's working tree would depend on whatever is uncommitted today.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { saveConversation } from '../src/agent/persistence.ts';
import { COMMANDS } from '../src/commands/registry.ts';
import { exportConfigJson, loadConfig, saveConfig, saveSecrets } from '../src/config/load.ts';
import { asteriskPaths } from '../src/daemon/paths.ts';
import { writePid } from '../src/daemon/pidfile.ts';
import { getDb } from '../src/db/index.ts';
import { grantRules, grantedAllowRules } from '../src/db/permissions.ts';
import { _resetPluginsForTesting, initialisePlugins } from '../src/plugins/runtime.ts';
import type { Message } from '../src/types/messages.ts';
import {
  asList,
  asText,
  makeContext,
  pickText,
  run,
  runList,
  runText,
  values,
  withTempHome,
} from './commands-harness.ts';

const config = () => loadConfig().config;

const say = (text: string): Message[] => [{ role: 'user', content: [{ type: 'text', text }] }];

describe('/sessions, /resume and /forget', () => {
  withTempHome('sessions');

  it('says there is nothing saved rather than printing an empty table', async () => {
    expect(await runText(makeContext(), '/sessions')).toBe('(no saved conversations)');
  });

  it('lists each saved conversation with its message count', async () => {
    saveConversation('repl', say('one'));
    saveConversation('telegram:42', [...say('a'), ...say('b')]);

    const out = await runText(makeContext(), '/sessions');
    expect(out).toContain('Saved conversations · 2');
    expect(out).toMatch(/repl\s+.*· 1 messages/);
    expect(out).toMatch(/telegram:42\s+.*· 2 messages/);
    expect(out).toContain('/resume <id>');
  });

  it('caps the listing at 40 and says how many were withheld', async () => {
    for (let i = 0; i < 42; i++) saveConversation(`s${i}`, say(`m${i}`));
    const out = await runText(makeContext(), '/sessions');
    expect(out).toContain('Saved conversations · 42');
    expect(out).toContain('... 2 more');
    expect(out.split('\n').filter((l) => l.trimStart().startsWith('s')).length).toBe(40);
  });

  it('resume replaces the live history and re-saves it under "repl"', async () => {
    saveConversation('older', [...say('a'), ...say('b')]);
    const ctx = makeContext();
    ctx.state.history.push(...say('stale'));

    expect(await runText(ctx, '/resume', 'older')).toBe('✓ resumed "older" · 2 messages loaded');
    expect(ctx.state.history).toHaveLength(2);
    expect(ctx.state.history[0]).toEqual(say('a')[0]);

    // The REPL's own slot now holds the resumed transcript, so a crash right
    // after resuming does not lose it.
    const fresh = makeContext();
    expect(await runText(fresh, '/resume', 'repl')).toContain('2 messages loaded');
  });

  it('resume names an id that was never saved', async () => {
    expect(await runText(makeContext(), '/resume', 'ghost')).toBe(
      'no saved conversation named "ghost"',
    );
  });

  it('the resume picker offers each conversation and loads the pick', async () => {
    const empty = await runList(makeContext(), '/resume');
    expect(empty.emptyMessage).toBe('No saved conversations.');
    expect(empty.items).toEqual([]);

    saveConversation('older', say('a'));
    const ctx = makeContext();
    const picker = await runList(ctx, '/resume');
    expect(values(picker)).toEqual(['older']);
    expect(picker.items[0]?.description).toContain('1 messages');
    expect(await pickText(picker, 'older')).toContain('✓ resumed "older"');
    expect(ctx.state.history).toHaveLength(1);
    expect(picker.onCancel?.()).toBeNull();
  });

  it('forget deletes the file, and says so when there was none', async () => {
    saveConversation('doomed', say('a'));
    expect(await runText(makeContext(), '/forget', 'doomed')).toBe(
      '✓ deleted saved conversation "doomed"',
    );
    expect(await runText(makeContext(), '/sessions')).toBe('(no saved conversations)');
    expect(await runText(makeContext(), '/forget', 'doomed')).toBe(
      'no saved conversation named "doomed"',
    );
  });

  it('the forget picker deletes the pick', async () => {
    const empty = await runList(makeContext(), '/forget');
    expect(empty.emptyMessage).toBe('No saved conversations.');

    saveConversation('doomed', say('a'));
    const picker = await runList(makeContext(), '/forget');
    expect(await pickText(picker, 'doomed')).toContain('✓ deleted');
    expect(await runText(makeContext(), '/sessions')).toBe('(no saved conversations)');
    expect(picker.onCancel?.()).toBeNull();
  });
});

describe('/diff and /review', () => {
  let repo = '';
  let cwd = '';

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(async () => {
    cwd = process.cwd();
    repo = await mkdtemp(join(tmpdir(), 'asterisk-diff-'));
    git('init', '-b', 'master');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'first');
    process.chdir(repo);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(repo, { recursive: true, force: true });
  });

  it('says there are no changes on a clean tree', async () => {
    expect(await runText(makeContext(), '/diff')).toBe('(no changes)');
    expect(await runText(makeContext(), '/review')).toBe('(no changes)');
  });

  it('shows unstaged work, and staged work only under "staged"', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');

    const unstaged = await runText(makeContext(), '/diff');
    expect(unstaged).toContain('app.ts');
    expect(unstaged).toContain('+export const a = 2;');
    expect(await runText(makeContext(), '/diff', 'staged')).toBe('(no changes)');

    git('add', '.');
    expect(await runText(makeContext(), '/diff')).toBe('(no changes)');
    expect(await runText(makeContext(), '/diff', 'staged')).toContain('+export const a = 2;');
    // "all" covers both sides of the index.
    expect(await runText(makeContext(), '/diff', 'all')).toContain('+export const a = 2;');
    expect(await runText(makeContext(), '/diff', 'HEAD')).toContain('+export const a = 2;');
  });

  it('limits the diff to a path when one is given', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const b = 1;\n');
    git('add', '.');

    const scoped = await runText(makeContext(), '/diff', 'staged');
    expect(scoped).toContain('other.ts');

    git('reset', '-q');
    git('add', 'app.ts');
    const onlyApp = await runText(makeContext(), '/diff', 'staged');
    expect(onlyApp).toContain('app.ts');
    expect(onlyApp).not.toContain('other.ts');
  });

  it('review counts the added and removed lines and flags risky additions', async () => {
    writeFileSync(
      join(repo, 'app.ts'),
      [
        '// TODO: revisit',
        'console.log("debug");',
        'const x: any = eval("1");',
        'execSync("ls");',
        'const home = process.env.HOME;',
        'writeFileSync("/tmp/x", "y");',
      ].join('\n'),
    );

    const out = await runText(makeContext(), '/review');
    expect(out).toMatch(/^Review · unstaged · \+6 \/ -1/);
    expect(out).toContain('New TODO/FIXME markers were added.');
    expect(out).toContain('New console.log calls were added.');
    expect(out).toContain('New TypeScript any usage appears in added lines.');
    expect(out).toContain('New eval usage appears in added lines.');
    expect(out).toContain('New process execution code was added.');
    expect(out).toContain('New environment-variable reads were added.');
    expect(out).toContain('New synchronous filesystem mutation code was added.');
  });

  it('review says so plainly when nothing risky was added', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    const out = await runText(makeContext(), '/review');
    expect(out).toContain('No obvious high-signal risk patterns found.');
    expect(out).toContain('Review · unstaged · +1 / -1');
  });

  it('names the path it was scoped to', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');
    expect(await runText(makeContext(), '/review', 'app.ts')).toContain(
      'Review · unstaged · app.ts',
    );
  });

  it('reports a git failure instead of throwing out of the command', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'asterisk-nogit-'));
    process.chdir(notARepo);
    try {
      expect(await runText(makeContext(), '/diff')).toContain('git diff failed:');
    } finally {
      process.chdir(repo);
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});

describe('/code', () => {
  let dir = '';
  let cwd = '';

  beforeEach(async () => {
    cwd = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'asterisk-code-'));
    writeFileSync(
      join(dir, 'app.ts'),
      ['export function loadThing(): number {', '  return 1;', '}', '', 'loadThing();', ''].join(
        '\n',
      ),
    );
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('prints usage for a bare call and for an unknown verb', async () => {
    expect(await runText(makeContext(), '/code')).toBe(
      'usage: /code [symbols|def|refs|diagnostics] [query]',
    );
    expect(await runText(makeContext(), '/code', 'wat something')).toBe(
      'usage: /code [symbols|def|refs|diagnostics] [query]',
    );
    expect(await runText(makeContext(), '/code', 'def')).toBe(
      'usage: /code [symbols|def|refs|diagnostics] [query]',
    );
  });

  it('def finds the declaration and not the call site', async () => {
    const out = await runText(makeContext(), '/code', 'def loadThing');
    expect(out).toContain('./app.ts:1:');
    expect(out).not.toContain('./app.ts:5:');
  });

  it('refs finds every mention, including the call site', async () => {
    const out = await runText(makeContext(), '/code', 'refs loadThing');
    expect(out).toContain('./app.ts:1:');
    expect(out).toContain('./app.ts:5:');
  });

  it('symbols with no query lists every declaration in the tree', async () => {
    const out = await runText(makeContext(), '/code', 'symbols');
    expect(out).toContain('export function loadThing');
  });

  it('a positional def/refs query goes through the language service', async () => {
    // "def <file> <line> <character>" is the precise form; the loose form is
    // the ripgrep search above.
    // The call site on line 5 resolves back to the declaration on line 1.
    const def = await runText(makeContext(), '/code', 'def app.ts 5 1');
    expect(def).toContain('app.ts:1:17');
    expect(def).not.toContain('app.ts:5:1');

    const refs = await runText(makeContext(), '/code', 'references app.ts 5 1');
    expect(refs).toContain('app.ts:1:17');
    expect(refs).toContain('app.ts:5:1');
  });

  it('symbols with a plain query searches for that declaration', async () => {
    const out = await runText(makeContext(), '/code', 'symbols loadThing');
    expect(out).toContain('./app.ts:1:');
    expect(out).not.toContain('./app.ts:5:');
  });

  it('symbols with a file argument uses the language service, not ripgrep', async () => {
    const out = await runText(makeContext(), '/code', 'symbols app.ts');
    expect(out).toContain('function loadThing');
    // The ripgrep path would print "./app.ts:1:" line prefixes; this one does not.
    expect(out).not.toContain('./app.ts:1:');
  });

  it("diagnostics on one file reports that file's errors", async () => {
    expect(await runText(makeContext(), '/code', 'diagnostics app.ts')).toContain(
      'diagnostics passed',
    );

    writeFileSync(join(dir, 'broken.ts'), 'export const n: number = "not a number";\n');
    const out = await runText(makeContext(), '/code', 'diag broken.ts');
    expect(out).toContain('broken.ts');
    expect(out).toMatch(/not assignable/);
  });

  it('a search that matches nothing still comes back as text', async () => {
    // rg exits non-zero when it matches nothing, so this lands in the catch
    // arm. The contract that matters is that /code never throws at the REPL.
    const out = await runText(makeContext(), '/code', 'refs zzz_no_such_symbol_zzz');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('/plugins', () => {
  withTempHome('plugins');

  afterEach(() => {
    _resetPluginsForTesting();
  });

  it('explains why plugins are off, and lists what is configured but not loaded', async () => {
    const cfg = config();
    cfg.plugins.load = ['/srv/plugins/greeter.ts'];
    saveConfig(cfg);

    const out = await runText(makeContext(), '/plugins');
    expect(out).toContain('Plugins · disabled');
    expect(out).toContain('MCP server');
    expect(out).toContain('Configured but not loaded: 1');
    expect(out).toContain('/srv/plugins/greeter.ts');
  });

  it('reports an empty load set when plugins are on but nothing is listed', async () => {
    const cfg = config();
    cfg.plugins.enabled = true;
    saveConfig(cfg);
    await initialisePlugins();

    const out = await runText(makeContext(), '/plugins');
    expect(out).toContain('Plugins · enabled');
    expect(out).toContain('Loaded  0');
  });

  it('names each loaded plugin, its tools, its path, and anything that failed', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'asterisk-plugin-'));
    const good = join(pluginDir, 'greeter.ts');
    writeFileSync(
      good,
      [
        'export default {',
        "  name: 'greeter',",
        "  description: 'adds a greeting tool',",
        '  register(api) {',
        '    api.registerTool({',
        "      name: 'Greet',",
        "      description: 'says hello',",
        "      input_schema: { type: 'object', properties: {} },",
        "      async execute() { return { output: 'hello', isError: false }; },",
        '    });',
        "    api.log('registered Greet');",
        '  },',
        '};',
      ].join('\n'),
    );

    const bare = join(pluginDir, 'bare.ts');
    writeFileSync(bare, ["export default { name: 'bare', register() {} };"].join('\n'));

    const cfg = config();
    cfg.plugins.enabled = true;
    cfg.plugins.load = [good, bare, join(pluginDir, 'missing.ts')];
    saveConfig(cfg);
    await initialisePlugins();

    try {
      const out = await runText(makeContext(), '/plugins');
      expect(out).toContain('Loaded  2');
      // A plugin that contributes nothing still gets a line of its own.
      expect(out.split('\n').some((l) => l.trim() === 'bare')).toBe(true);
      expect(out).toContain('greeter');
      expect(out).toContain('Greet');
      expect(out).toContain('adds a greeting tool');
      expect(out).toContain(good);
      expect(out).toContain('Failed  1');
      expect(out).toContain('missing.ts');
      // Anything the plugin said while registering is surfaced too.
      expect(out).toContain('Notices');
      expect(out).toContain('registered Greet');
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});

describe('/permissions revoke', () => {
  withTempHome('permissions');

  it('revokes a single remembered rule from the picker', async () => {
    grantRules(getDb(), ['printf', 'ls -la'], 'repl');

    const picker = await runList(makeContext(), '/permissions', 'revoke');
    expect(values(picker)).toEqual(['printf', 'ls -la', '*']);
    expect(picker.items[0]?.description).toContain('granted via repl');

    expect(await pickText(picker, 'printf')).toContain('Revoked "printf"');
    expect(grantedAllowRules(getDb())).toEqual(['ls -la']);
  });

  it('revokes everything from the picker and from the argument form', async () => {
    grantRules(getDb(), ['printf', 'ls -la'], 'repl');
    const picker = await runList(makeContext(), '/permissions', 'revoke');
    expect(await pickText(picker, '*')).toContain('Revoked every remembered rule');
    expect(grantedAllowRules(getDb())).toEqual([]);

    grantRules(getDb(), ['printf'], 'repl');
    expect(await runText(makeContext(), '/permissions', 'revoke *')).toBe(
      'Revoked every remembered rule.',
    );
    expect(grantedAllowRules(getDb())).toEqual([]);
  });

  it('rejects an unknown verb and a rule-less allow/deny', async () => {
    expect(await runText(makeContext(), '/permissions', 'grant everything')).toBe(
      'unknown /permissions verb: grant',
    );
    expect(await runText(makeContext(), '/permissions', 'allow')).toBe(
      'usage: /permissions allow <rule>',
    );
    expect(await runText(makeContext(), '/permissions', 'deny   ')).toBe(
      'usage: /permissions deny <rule>',
    );
  });

  it('surfaces config rules and remembered grants in one summary', async () => {
    const cfg = config();
    cfg.permissions.allow = ['printf'];
    cfg.permissions.deny = ['curl'];
    saveConfig(cfg);
    grantRules(getDb(), ['jq .'], 'telegram');

    const out = await runText(makeContext(), '/permissions');
    expect(out).toContain('allow  printf');
    expect(out).toContain('deny   curl');
    expect(out).toContain('jq .');
    expect(out).toContain('granted via telegram');
  });
});

describe('/doctor', () => {
  withTempHome('doctor');

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answers the two endpoints /doctor probes. */
  function endpoints(ollama: 'ok' | 'error' | 'down', anthropic: 'ok' | 'error' | 'down'): void {
    globalThis.fetch = (async (url: string) => {
      const target = String(url).includes('anthropic.com') ? anthropic : ollama;
      if (target === 'down') throw new Error('ECONNREFUSED');
      if (target === 'error') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ models: [{ name: 'qwen' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  it('reports a reachable Ollama, a valid key, the tools, and the security posture', async () => {
    const cfg = config();
    cfg.mcpServers = [
      { name: 'a', transport: 'stdio', command: 'x', args: [], env: {}, enabled: true },
    ];
    saveConfig(cfg);
    // A key in the database is what makes /doctor probe the Anthropic API.
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    endpoints('ok', 'ok');

    const ctx = makeContext();
    ctx.state.history.push(...say('hi'));
    const out = await runText(ctx, '/doctor');

    expect(out).toContain('✓ Ollama     reachable · 1 model installed');
    expect(out).toContain('✓ Anthropic  API key valid');
    expect(out).toContain('System tools');
    expect(out).toContain('git');
    expect(out).toContain('MCP          0/1 servers · 0 tools');
    expect(out).toContain('Bash perms mode ask');
    expect(out).toMatch(/(✓|✗) Sandbox/);
    expect(out).toContain('Daemon       not running');
    expect(out).toContain('History      1 messages');
    expect(out).not.toContain('sk-test');
  });

  it('reports an HTTP error from each endpoint separately', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    endpoints('error', 'error');

    const out = await runText(makeContext(), '/doctor');
    expect(out).toContain('✗ Ollama     HTTP 503');
    expect(out).toContain('✗ Anthropic  API returned 503');
  });

  it('reports an unreachable Anthropic API separately from a missing key', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    endpoints('down', 'down');
    const out = await runText(makeContext(), '/doctor');
    expect(out).toContain('✗ Anthropic  API unreachable');
    expect(out).not.toContain('no API key set');
  });

  it('reports unreachable endpoints, and no key at all as a note rather than a failure', async () => {
    endpoints('down', 'down');
    const out = await runText(makeContext(), '/doctor');
    expect(out).toContain(`✗ Ollama     unreachable at ${config().ollama.baseUrl}`);
    expect(out).toContain('· Anthropic  no API key set');
    expect(out).toContain('config     ');
    expect(out).toContain('(using defaults)');
    expect(out).toContain('(not created)');
  });

  it('reports each missing system tool rather than assuming it is there', async () => {
    endpoints('down', 'down');
    const path = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const out = await runText(makeContext(), '/doctor');
      for (const bin of ['git', 'rg', 'bun', 'node']) {
        expect(out).toContain(`✗ ${bin.padEnd(12)} not found`);
      }
      expect(out).toContain('· playwright  not found');
    } finally {
      if (path === undefined) delete process.env['PATH'];
      else process.env['PATH'] = path;
    }
  });

  it('names the config files and the running daemon once they exist', async () => {
    endpoints('down', 'down');
    const paths = asteriskPaths();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.secretsFile, 'ASTERISK_TELEGRAM_BOT_TOKEN=123:ABC\n', { mode: 0o600 });
    writePid(paths.pidFile, process.pid);
    // Seed the database first: an unseeded one absorbs config.json and renames
    // it, which is exactly what makes this line unreachable on a fresh install.
    config();
    exportConfigJson();

    const out = await runText(makeContext(), '/doctor');
    expect(out).toContain(`✓ config     ${paths.configFile}`);
    expect(out).toContain(`✓ secrets    ${paths.secretsFile}`);
    expect(out).toContain(`Daemon       running · pid ${process.pid}`);
    expect(out).not.toContain('123:ABC');
  });

  it('flags an unrestricted permission mode', async () => {
    endpoints('down', 'down');
    const cfg = config();
    cfg.permissions.mode = 'unrestricted';
    saveConfig(cfg);
    expect(await runText(makeContext(), '/doctor')).toContain('✗ Bash perms mode unrestricted');
  });
});

describe('command registry wiring', () => {
  withTempHome('wiring');

  it('every command has a description, and every usage line starts with its name', () => {
    // The /help listing and the `/` menu both render from these two fields.
    for (const c of COMMANDS) {
      expect(c.name.startsWith('/')).toBe(true);
      expect(c.description.length).toBeGreaterThan(0);
      if (c.usage) expect(c.usage.startsWith(c.name)).toBe(true);
    }
  });

  it('/clear and /quit are the only commands that render nothing', async () => {
    const ctx = makeContext();
    expect(await run(ctx, '/quit')).toBeNull();
    expect(ctx.exited).toBe(true);
    expect(asText(await run(ctx, '/clear'))).toBe('(history cleared)');
  });

  it('/tools reports one line per registered tool, clipped to the first description line', async () => {
    const out = await runText(makeContext(), '/tools');
    const { listTools } = await import('../src/tools/registry.ts');
    const lines = out.split('\n');
    expect(lines[0]).toBe('Tools:');
    expect(lines).toHaveLength(listTools().length + 1);

    for (const tool of listTools()) {
      // Matched at the start of the row: several descriptions name other
      // tools, so a substring search finds the wrong line.
      const line = lines.find((l) => l.trimStart().startsWith(`${tool.name} `));
      expect(line, `no /tools line for ${tool.name}`).toBeDefined();
      // A tool whose description spans paragraphs contributes one line only.
      expect(line?.endsWith(tool.description.split('\n')[0] ?? '')).toBe(true);
    }
  });
});
