// The commands that live in registry.ts itself: model/provider switching,
// /status, /reset, /rules, /soul, /skill, /agents, /output-style, /plan,
// /tasks and /update.
//
// These are mostly text renderers, so the assertions are on the facts each one
// reports (which provider is active, whether a token is set, what got written
// to disk) rather than on spacing.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runWithSession } from '../src/agent/context.ts';
import { loadConfig, saveConfig, saveSecrets } from '../src/config/load.ts';
import { asteriskPaths } from '../src/daemon/paths.ts';
import { writePid } from '../src/daemon/pidfile.ts';
import { setPlanMode } from '../src/tools/planmode.ts';
import { _resetTasksForTesting, taskCreateTool, taskUpdateTool } from '../src/tools/tasks.ts';
import type { Provider } from '../src/types/messages.ts';
import {
  asList,
  asText,
  fakeMcp,
  fakeServer,
  makeContext,
  pickText,
  run,
  runList,
  runText,
  values,
  withTempHome,
} from './commands-harness.ts';

const config = () => loadConfig().config;

/** A provider that only has to report a name — nothing here sends a request. */
function named(name: string): Provider {
  return {
    name,
    async send() {
      throw new Error('the tests never send through this provider');
    },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function unreachable(): void {
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

describe('/help', () => {
  withTempHome('help');

  it('names an unknown command instead of listing everything', async () => {
    expect(await runText(makeContext(), '/help', 'nope')).toBe('unknown command: /nope');
    expect(await runText(makeContext(), '/help', '/nope')).toBe('unknown command: /nope');
  });

  it('shows the usage line for a command that has one, and omits it otherwise', async () => {
    const withUsage = await runText(makeContext(), '/help', 'mcp');
    expect(withUsage).toContain('usage: /mcp');
    const withoutUsage = await runText(makeContext(), '/help', 'clear');
    expect(withoutUsage).not.toContain('usage:');
  });
});

describe('/model switching', () => {
  withTempHome('model');

  it('switches the live provider and remembers the backend it was on', async () => {
    const ctx = makeContext({ provider: named('ollama:old-model') });
    expect(await runText(ctx, '/model', ' new-model ')).toBe('✓ switched to ollama:new-model');
    expect(ctx.provider.name).toBe('ollama:new-model');
  });

  it('switches the openai-compatible model without touching the ollama one', async () => {
    const before = config().ollama.model;
    const ctx = makeContext({ provider: named('openai-compatible:small') });
    expect(await runText(ctx, '/model', 'big')).toBe('✓ switched to openai-compatible:big');
    expect(ctx.provider.name).toBe('openai-compatible:big');
    expect(config().ollama.model).toBe(before);
  });

  it('refuses to switch an Anthropic model with no key, and does not touch the provider', async () => {
    const ctx = makeContext({ provider: named('anthropic:claude-opus-5') });
    expect(await runText(ctx, '/model', 'claude-sonnet-5')).toBe(
      'ANTHROPIC_API_KEY not set; run `asterisk configure`',
    );
    expect(ctx.provider.name).toBe('anthropic:claude-opus-5');
  });

  it('switches the Anthropic model once a key exists', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    const ctx = makeContext({ provider: named('anthropic:claude-opus-5') });
    expect(await runText(ctx, '/model', 'claude-sonnet-5')).toBe(
      '✓ switched to anthropic:claude-sonnet-5',
    );
    expect(ctx.provider.name).toBe('anthropic:claude-sonnet-5');
  });

  it('says so when it cannot tell which backend is active', async () => {
    const ctx = makeContext({ provider: named('mystery-backend') });
    expect(await runText(ctx, '/model', 'anything')).toBe(
      'cannot parse current provider: mystery-backend',
    );
  });

  it('the switch is in-memory — it does not rewrite the stored default', async () => {
    // /config is what persists a model; /model is for the current session.
    const ctx = makeContext({ provider: named('ollama:old-model') });
    await run(ctx, '/model', 'new-model');
    expect(config().ollama.model).not.toBe('new-model');
  });
});

describe('/model picker', () => {
  withTempHome('model-picker');

  it('lists installed Ollama models, badges the current one, and switches on pick', async () => {
    respond({ models: [{ name: 'qwen3.5:9b' }, { name: 'gemma:2b' }] });
    const ctx = makeContext({ provider: named('ollama:gemma:2b') });

    const picker = await runList(ctx, '/model');
    expect(picker.title).toBe('Pick a model');
    expect(values(picker)).toEqual(['qwen3.5:9b', 'gemma:2b']);
    expect(picker.items[0]?.badge).toBeUndefined();
    expect(picker.items[1]?.badge).toBe('* current');

    expect(await pickText(picker, 'qwen3.5:9b')).toBe('✓ switched to ollama:qwen3.5:9b');
    expect(ctx.provider.name).toBe('ollama:qwen3.5:9b');
    expect(picker.onCancel?.()).toBeNull();
  });

  it('reports the unreachable base URL instead of an empty picker', async () => {
    unreachable();
    const cfg = config();
    cfg.ollama.baseUrl = 'http://127.0.0.1:65000';
    saveConfig(cfg);

    expect(await runText(makeContext(), '/model')).toBe(
      '(could not reach Ollama at http://127.0.0.1:65000)',
    );
  });

  it('offers the offline Anthropic list without a key, and says the list is offline', async () => {
    const ctx = makeContext({ provider: named('anthropic:claude-opus-5') });
    const picker = await runList(ctx, '/model');

    expect(picker.title).toBe('Pick an Anthropic model (offline list)');
    expect(values(picker)).toContain('claude-opus-5');
    const current = picker.items.find((i) => i.value === 'claude-opus-5');
    expect(current?.badge).toBe('* current');
    // The fallback list has human labels, so the id is shown as the subtitle.
    expect(current?.description).toBe('claude-opus-5');
  });

  it('offers the live Anthropic list with a key, and drops a description that would repeat the id', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    respond({ data: [{ id: 'claude-live-1' }, { id: 'claude-live-2', display_name: 'Live Two' }] });
    const ctx = makeContext({ provider: named('anthropic:claude-opus-5') });

    const picker = await runList(ctx, '/model');
    expect(picker.title).toBe('Pick an Anthropic model');
    expect(picker.items[0]).toEqual({ value: 'claude-live-1', label: 'claude-live-1' });
    expect(picker.items[1]).toMatchObject({ label: 'Live Two', description: 'claude-live-2' });

    expect(await pickText(picker, 'claude-live-2')).toBe('✓ switched to anthropic:claude-live-2');
  });

  it('badges the running model when the live list contains it', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    respond({ data: [{ id: 'claude-opus-5', display_name: 'Opus 5' }] });
    const ctx = makeContext({ provider: named('anthropic:claude-opus-5') });

    const picker = await runList(ctx, '/model');
    expect(picker.items[0]).toMatchObject({ badge: '* current', description: 'claude-opus-5' });
    expect(picker.onCancel?.()).toBeNull();
  });
});

describe('/provider', () => {
  withTempHome('provider');

  it('switches backend and reports the provider that was actually built', async () => {
    const ctx = makeContext();
    expect(await runText(ctx, '/provider', 'openai-compatible')).toMatch(
      /^✓ switched to openai-compatible:/,
    );
    expect(ctx.provider.name.startsWith('openai-compatible:')).toBe(true);
  });

  it('refuses anthropic without a key, and accepts it with one', async () => {
    const ctx = makeContext();
    expect(await runText(ctx, '/provider', 'ANTHROPIC')).toBe(
      'ANTHROPIC_API_KEY not set; run `asterisk configure`',
    );
    expect(ctx.provider.name.startsWith('ollama:')).toBe(true);

    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(await runText(ctx, '/provider', 'anthropic')).toMatch(/^✓ switched to anthropic:/);
    expect(ctx.provider.name.startsWith('anthropic:')).toBe(true);
  });

  it('badges whichever backend is live and switches on pick', async () => {
    const ctx = makeContext({ provider: named('openai-compatible:local') });
    const picker = await runList(ctx, '/provider');

    const badge = (value: string): string | undefined =>
      picker.items.find((i) => i.value === value)?.badge;
    expect(badge('openai-compatible')).toBe('* current');
    expect(badge('ollama')).toBeUndefined();
    expect(badge('anthropic')).toBeUndefined();
    // Each row names the model that backend would use.
    expect(picker.items.find((i) => i.value === 'ollama')?.description).toBe(config().ollama.model);

    expect(await pickText(picker, 'ollama')).toMatch(/^✓ switched to ollama:/);
    expect(ctx.provider.name.startsWith('ollama:')).toBe(true);
    expect(picker.onCancel?.()).toBeNull();
  });
});

describe('/reset', () => {
  withTempHome('reset');

  it('clears history and rebuilds the provider from config', async () => {
    const ctx = makeContext({ provider: named('ollama:stale') });
    ctx.state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });

    expect(await runText(ctx, '/reset')).toBe('(reset — provider ollama)');
    expect(ctx.cleared).toBe(true);
    expect(ctx.state.history).toHaveLength(0);
    expect(ctx.provider.name).toBe(`ollama:${config().ollama.model}`);
  });

  it('says why it could not honour the configured provider', async () => {
    const cfg = config();
    cfg.provider = 'anthropic';
    saveConfig(cfg);

    const out = await runText(makeContext(), '/reset');
    expect(out).toContain('ANTHROPIC_API_KEY is not set');
    expect(out).toContain('using ollama');
  });
});

describe('/status', () => {
  withTempHome('status');

  it('reports defaults: bots off, no MCP, no daemon, files not yet created', async () => {
    const out = await status();
    expect(out).toContain('Telegram   disabled');
    expect(out).toContain('MCP        none configured');
    expect(out).toContain('Daemon     not running');
    expect(out).toContain('not yet created');
    expect(out).toContain('using defaults (file not yet created)');
  });

  it('warns when Telegram is enabled without a token, and stops warning once one is set', async () => {
    const cfg = config();
    cfg.bots.telegram.enabled = true;
    cfg.bots.telegram.allowedUserIds = [1, 2];
    saveConfig(cfg);

    const before = await status();
    expect(before).toContain('2 allowlisted');
    expect(before).toContain('NO TOKEN');

    saveSecrets({ ASTERISK_TELEGRAM_BOT_TOKEN: '123:ABC' });
    const after = await status();
    expect(after).toContain('token set');
    expect(after).not.toContain('NO TOKEN');
    // The token itself must never be printed.
    expect(after).not.toContain('123:ABC');
  });

  it('counts connected servers against configured ones and pluralises the tool count', async () => {
    const cfg = config();
    cfg.mcpServers = [
      { name: 'a', transport: 'stdio', command: 'x', args: [], env: {}, enabled: true },
      { name: 'b', transport: 'http', url: 'https://e/mcp', headers: {}, enabled: true },
    ];
    saveConfig(cfg);

    const tool = {
      name: 'mcp__a__ping',
      description: 'ping',
      input_schema: { type: 'object' as const, properties: {} },
      async execute() {
        return { output: '', isError: false };
      },
    };
    const one = await status(makeContext({ mcp: fakeMcp([fakeServer('a')], [tool]) }));
    expect(one).toContain('MCP        1/2 connected · 1 tool');
    const two = await status(makeContext({ mcp: fakeMcp([fakeServer('a')], [tool, tool]) }));
    expect(two).toContain('· 2 tools');
  });

  it('describes the provider per backend, falling back to the raw name', async () => {
    const ollama = await status(makeContext({ provider: named('ollama:qwen') }));
    expect(ollama).toContain(`Provider   ollama · qwen · ${config().ollama.baseUrl}`);

    const anthropic = await status(makeContext({ provider: named('anthropic:claude-opus-5') }));
    expect(anthropic).toContain('Provider   anthropic · claude-opus-5');

    const other = await status(makeContext({ provider: named('openai-compatible:local') }));
    expect(other).toContain('Provider   openai-compatible:local');
  });

  it('pluralises the history count', async () => {
    const ctx = makeContext();
    expect(await status(ctx)).toContain('History    0 messages');
    ctx.state.history.push({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(await status(ctx)).toContain('History    1 message\n');
  });

  it('reports a live daemon and a stale pid file differently', async () => {
    const paths = asteriskPaths();
    mkdirSync(paths.root, { recursive: true });

    writePid(paths.pidFile, process.pid);
    expect(await status()).toContain(`Daemon     running · pid ${process.pid}`);

    // A pid that cannot be alive — the file outlived the process.
    writePid(paths.pidFile, 0x7fffffff);
    expect(await status()).toContain('not running (stale pid file)');
  });

  it('names the config and secrets files once they exist', async () => {
    const paths = asteriskPaths();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.configFile, '{}\n');
    writeFileSync(paths.secretsFile, 'ANTHROPIC_API_KEY=sk-legacy\n', { mode: 0o600 });

    const out = await status();
    expect(out).toContain(`Config     ${paths.configFile}`);
    expect(out).not.toContain('file not yet created');
    expect(out).toContain('chmod 600');
    expect(out).toContain(`Home       ${paths.root}`);
    expect(out).not.toContain('sk-legacy');
  });

  /** /status always renders text; this unwraps it. */
  async function status(ctx = makeContext()): Promise<string> {
    return asText(await run(ctx, '/status'), '/status');
  }
});

describe('/rules', () => {
  withTempHome('rules');

  it('explains where to put rules when none are loaded', async () => {
    const out = await runText(makeContext(), '/rules');
    expect(out).toContain('No rules loaded.');
    expect(out).toContain('ASTERISK.md');
  });

  it('lists each loaded rule with its scope, size and path', async () => {
    const dir = join(asteriskPaths().root, 'rules');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'style.md'), '# Style\nUse tabs.');

    const out = await runText(makeContext(), '/rules');
    expect(out).toContain('Rules  1 file ·');
    expect(out).toContain('user');
    expect(out).toContain('style');
    expect(out).toContain(join(dir, 'style.md'));

    writeFileSync(join(dir, 'security.md'), '# Security\nNo secrets in source.');
    expect(await runText(makeContext(), '/rules')).toContain('Rules  2 files ·');
  });
});

describe('/soul', () => {
  withTempHome('soul');

  it('lists the candidate paths in resolution order', async () => {
    const out = await runText(makeContext(), '/soul', 'where');
    expect(out).toContain(join(asteriskPaths().root, 'SOUL.md'));
    expect(out).toContain(`${process.cwd()}/SOUL.md`);
    expect(await runText(makeContext(), '/soul', 'paths')).toBe(out);
  });

  it('explains how to create one when nothing is loaded', async () => {
    const out = await runText(makeContext(), '/soul');
    expect(out).toContain('No SOUL.md loaded.');
    expect(out).toContain('/soul init');
  });

  it('init writes the starter template once and refuses to clobber it', async () => {
    const path = join(asteriskPaths().root, 'SOUL.md');
    const first = await runText(makeContext(), '/soul', 'init');
    expect(first).toContain(`✓ wrote starter SOUL.md to ${path}`);

    const second = await runText(makeContext(), '/soul', 'init');
    expect(second).toContain('already exists');

    const shown = await runText(makeContext(), '/soul', 'show');
    expect(shown).toContain('Soul · 1 loaded');
    expect(shown).toContain(path);
    expect(shown).toContain('--- content ---');
  });
});

describe('/skill', () => {
  withTempHome('skill');

  it('names an unknown skill', async () => {
    expect(await runText(makeContext(), '/skill', 'no-such-skill')).toBe(
      'unknown skill: no-such-skill',
    );
  });

  it('renders the skill prompt when the REPL cannot type for the user', async () => {
    const out = await runText(makeContext(), '/skill', 'simplify');
    expect(out.startsWith('Skill: simplify')).toBe(true);
    expect(out.length).toBeGreaterThan('Skill: simplify'.length);
  });

  it('loads the prompt into the input when the REPL offered an injector', async () => {
    const ctx = makeContext({ withInjectInput: true });
    expect(await runText(ctx, '/skill', 'simplify')).toBe(
      '✓ skill "simplify" loaded into the input — press Enter to run',
    );
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]).toBeTruthy();
  });

  it('offers every loaded skill, badges bundled ones, and runs the pick', async () => {
    const dir = join(asteriskPaths().root, 'skills', 'mine');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: mine\ndescription: A user skill\n---\nDo the thing.',
    );

    const ctx = makeContext({ withInjectInput: true });
    const picker = await runList(ctx, '/skill');
    expect(values(picker)).toContain('mine');
    expect(values(picker)).toContain('simplify');
    expect(picker.items.find((i) => i.value === 'simplify')?.badge).toBe('* bundled');
    expect(picker.items.find((i) => i.value === 'mine')).toMatchObject({
      description: 'A user skill',
    });
    expect(picker.items.find((i) => i.value === 'mine')?.badge).toBeUndefined();

    expect(await pickText(picker, 'mine')).toContain('loaded into the input');
    expect(ctx.injected[0]).toBe('Do the thing.');
    expect(asText(await picker.onPick('vanished'))).toBe('unknown skill: vanished');
    expect(picker.onCancel?.()).toBeNull();
  });
});

describe('/agents', () => {
  withTempHome('agents');

  it('lists the bundled types and explains how they are dispatched', async () => {
    const out = await runText(makeContext(), '/agents');
    expect(out).toMatch(/^Agents · \d+ available/);
    expect(out).toContain('bundled');
    expect(out).toContain('subagent_type');
  });

  it('shows a user agent alongside the bundled ones and counts its tool allowlist', async () => {
    const dir = join(asteriskPaths().root, 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'auditor.md'),
      '---\nname: auditor\ndescription: Reads only\nallowedTools: [Read, Grep]\n---\nAudit it.',
    );

    const out = await runText(makeContext(), '/agents');
    const line = out.split('\n').find((l) => l.includes('auditor')) ?? '';
    expect(line).toContain('user');
    expect(line).toContain('Reads only');
    expect(line).toContain('2 tools');
  });
});

describe('/output-style', () => {
  withTempHome('output-style');

  it('persists the chosen style', async () => {
    expect(config().outputStyle).toBe('default');
    const out = await runText(makeContext(), '/output-style', ' CONCISE ');
    expect(out).toContain('output style set to "concise"');
    expect(config().outputStyle).toBe('concise');
  });

  it('names the valid styles when asked for one that does not exist', async () => {
    const out = await runText(makeContext(), '/output-style', 'terse');
    expect(out).toContain('unknown output style "terse"');
    expect(out).toContain('concise');
    expect(config().outputStyle).toBe('default');
  });

  it('offers every style in the picker and applies the pick', async () => {
    const picker = await runList(makeContext(), '/output-style');
    expect(values(picker)).toEqual(['default', 'concise', 'explanatory', 'learning']);
    for (const item of picker.items) expect(item.description).toBeTruthy();

    expect(await pickText(picker, 'learning')).toContain('set to "learning"');
    expect(config().outputStyle).toBe('learning');
  });
});

describe('/plan and /tasks', () => {
  withTempHome('plan');

  afterEach(() => {
    // Plan mode is process-global, keyed by session id.
    runWithSession({ id: 'repl', scope: 'repl' }, async () => setPlanMode(false));
    _resetTasksForTesting();
  });

  it('toggles plan mode on and back off', async () => {
    const ctx = makeContext();
    expect(await runText(ctx, '/plan')).toContain('Plan Mode ON');
    expect(await runText(ctx, '/plan')).toContain('Plan Mode OFF');
    expect(await runText(ctx, '/plan')).toContain('Plan Mode ON');
  });

  it('says there are no tasks rather than printing an empty header', async () => {
    expect(await runText(makeContext(), '/tasks')).toContain('(no tasks');
  });

  it('lists the session tasks with a status icon each', async () => {
    await runWithSession({ id: 'repl', scope: 'repl' }, async () => {
      await taskCreateTool.execute({ title: 'first', description: 'with detail' });
      await taskCreateTool.execute({ title: 'second' });
      await taskCreateTool.execute({ title: 'third' });
      await taskCreateTool.execute({ title: 'fourth' });
      await taskUpdateTool.execute({ id: '2', status: 'in_progress' });
      await taskUpdateTool.execute({ id: '3', status: 'completed' });
      await taskUpdateTool.execute({ id: '4', status: 'cancelled' });
    });

    const out = await runText(makeContext(), '/tasks');
    expect(out).toContain('Tasks · 4 total');
    expect(out).toContain('○ #1  first — with detail');
    expect(out).toContain('◐ #2  second');
    expect(out).toContain('✓ #3  third');
    expect(out).toContain('✗ #4  fourth');
  });

  it('only shows the REPL session tasks', async () => {
    await runWithSession({ id: 'telegram:1', scope: 'telegram' }, async () => {
      await taskCreateTool.execute({ title: 'someone else' });
    });
    expect(await runText(makeContext(), '/tasks')).toContain('(no tasks');
  });
});

describe('/update', () => {
  const home = withTempHome('update');

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  /** A bare "origin", a seed clone that pushes to it, and the install checkout. */
  function checkout(): { seed: string; install: string; origin: string } {
    const origin = join(home(), 'origin.git');
    const seed = join(home(), 'seed');
    const install = join(home(), 'install');
    for (const dir of [origin, seed]) mkdirSync(dir, { recursive: true });

    git(origin, 'init', '--bare', '-b', 'master');
    git(seed, 'init', '-b', 'master');
    commit(seed, 'first commit');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'master');
    execFileSync('git', ['clone', '-q', origin, install], { encoding: 'utf8' });

    process.env['ASTERISK_INSTALL_DIR'] = install;
    process.env['ASTERISK_BRANCH'] = 'master';
    return { seed, install, origin };
  }

  function commit(cwd: string, message: string): void {
    writeFileSync(join(cwd, 'README.md'), `${message}\n`);
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', message);
  }

  it('refuses to work outside a git checkout', async () => {
    process.env['ASTERISK_INSTALL_DIR'] = asteriskPaths().root;
    const out = await runText(makeContext(), '/update', 'check');
    expect(out).toContain('is not a git repository');
    expect(out).toContain('install.sh');
  });

  it('reports being up to date, naming the version and the local head', async () => {
    const { install } = checkout();
    const head = git(install, 'rev-parse', 'HEAD').slice(0, 10);

    const out = await runText(makeContext(), '/update', 'check');
    expect(out).toContain('✓ Already up to date');
    expect(out).toContain(head);
  });

  it('lists what a check would bring in without touching the checkout', async () => {
    const { seed, install } = checkout();
    const before = git(install, 'rev-parse', 'HEAD');
    commit(seed, 'second commit');
    git(seed, 'push', '-q', 'origin', 'master');

    const out = await runText(makeContext(), '/update', 'check');
    expect(out).toContain('Update available: 1 new commit');
    expect(out).toContain('second commit');
    expect(out).toContain('Run /update to apply');
    // "check" is read-only: the working copy is still on the old commit.
    expect(git(install, 'rev-parse', 'HEAD')).toBe(before);

    commit(seed, 'third commit');
    git(seed, 'push', '-q', 'origin', 'master');
    expect(await runText(makeContext(), '/update', 'check')).toContain(
      'Update available: 2 new commits',
    );
  });

  it('reports a fetch failure rather than a stack trace', async () => {
    const { install } = checkout();
    git(install, 'remote', 'set-url', 'origin', join(home(), 'gone.git'));
    expect(await runText(makeContext(), '/update', 'check')).toBe(
      '✗ git fetch failed — check your network connection.',
    );
  });
});
