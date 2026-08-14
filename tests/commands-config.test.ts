// `/config` and `/hooks` end to end.
//
// Same shape as the /mcp tests: take the returned spec, invoke the callback
// the REPL would invoke, then assert against the stored config. The forms are
// the only writer for most of these settings, so a dropped field here is a
// setting the user cannot change at all.

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, saveConfig, saveSecrets } from '../src/config/load.ts';
import type { HookConfig } from '../src/config/schema.ts';
import {
  asForm,
  asList,
  asText,
  field,
  keys,
  makeContext,
  run,
  runForm,
  runList,
  runText,
  submitText,
  values,
  withTempHome,
} from './commands-harness.ts';

const config = () => loadConfig().config;
const secrets = () => loadConfig().secrets;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondModels(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** A form for one config section, opened the way the REPL opens it. */
const section = (name: string) => runForm(makeContext(), '/config', name);

describe('/config section routing', () => {
  withTempHome('config');

  it('offers every section and opens the one that is picked', async () => {
    const picker = await runList(makeContext(), '/config');
    expect(values(picker)).toEqual([
      'provider',
      'openai-compatible',
      'anthropic',
      'telegram',
      'daemon',
    ]);
    for (const item of picker.items) {
      expect(item.label).toBeTruthy();
      expect(item.description).toBeTruthy();
    }
    expect(asForm(await picker.onPick('daemon')).title).toBe('Daemon settings');
    expect(asText(await picker.onPick('nope'))).toBe('unknown config section: nope');
    expect(picker.onCancel?.()).toBeNull();
  });

  it('names an unknown section instead of opening the picker anyway', async () => {
    expect(await runText(makeContext(), '/config', 'telgram')).toBe(
      'unknown config section: telgram',
    );
  });

  it('matches a section case-insensitively', async () => {
    expect((await section('DAEMON')).title).toBe('Daemon settings');
  });
});

describe('/config provider', () => {
  withTempHome('config-provider');

  it('writes the chosen provider', async () => {
    expect(config().provider).toBe('openai-compatible');
    expect(await submitText(await section('provider'), { provider: 'anthropic' })).toContain(
      'set to anthropic',
    );
    expect(config().provider).toBe('anthropic');
  });

  it('keeps the current provider when the form yields no value', async () => {
    const cfg = config();
    cfg.provider = 'anthropic';
    saveConfig(cfg);
    await submitText(await section('provider'), {});
    expect(config().provider).toBe('anthropic');
  });

  it('prefills with the stored provider', async () => {
    const cfg = config();
    cfg.provider = 'anthropic';
    saveConfig(cfg);
    expect(field(await section('provider'), 'provider')).toMatchObject({
      defaultValue: 'anthropic',
    });
  });

  it('cancelling writes nothing', async () => {
    const form = await section('provider');
    expect(await form.onCancel?.()).toBe('(cancelled)');
    expect(config().provider).toBe('openai-compatible');
  });
});

describe('/config local model', () => {
  withTempHome('config-local-model');

  it('trims the URL and model and accepts a context window', async () => {
    await submitText(await section('openai-compatible'), {
      baseUrl: '  http://10.0.0.5:8080/v1  ',
      model: '  qwen3.5:9b  ',
      contextWindow: '65536',
    });
    expect(config().openaiCompatible).toMatchObject({
      baseUrl: 'http://10.0.0.5:8080/v1',
      model: 'qwen3.5:9b',
      contextWindow: 65536,
    });
  });

  it('accepts an empty model, because that is how detection is re-enabled', async () => {
    await submitText(await section('openai-compatible'), { model: 'pinned-model' });
    expect(config().openaiCompatible.model).toBe('pinned-model');

    await submitText(await section('openai-compatible'), { model: '   ' });
    expect(config().openaiCompatible.model).toBe('');
  });

  it('ignores a non-numeric context window rather than storing it', async () => {
    await submitText(await section('openai-compatible'), { contextWindow: '65536' });
    for (const bad of ['', 'many', '-1']) {
      await submitText(await section('openai-compatible'), { contextWindow: bad });
      expect(config().openaiCompatible.contextWindow).toBe(65536);
    }
    // 0 is meaningful here: "take the server's window".
    await submitText(await section('openai-compatible'), { contextWindow: '0' });
    expect(config().openaiCompatible.contextWindow).toBe(0);
  });

  it('prefills from the stored settings', async () => {
    const form = await section('openai-compatible');
    expect(field(form, 'baseUrl')).toMatchObject({
      defaultValue: config().openaiCompatible.baseUrl,
    });
    expect(field(form, 'contextWindow')).toMatchObject({
      defaultValue: String(config().openaiCompatible.contextWindow),
    });
  });
});

describe('/config anthropic', () => {
  withTempHome('config-anthropic');

  it('offers the offline model list and says so when there is no key', async () => {
    const form = await section('anthropic');
    expect(form.title).toContain('offline list');
    const select = field(form, 'model');
    expect(select.kind).toBe('select');
    if (select.kind !== 'select') throw new Error('model field should be a select');
    expect(select.options.length).toBeGreaterThan(0);
    expect(field(form, 'apiKey')).toMatchObject({ secret: true, placeholder: '(unset)' });
  });

  it('offers the live list when a key is stored', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    respondModels({ data: [{ id: 'claude-live-1', display_name: 'Claude Live' }] });

    const form = await section('anthropic');
    expect(form.title).toContain('1 models from /v1/models');
    const select = field(form, 'model');
    if (select.kind !== 'select') throw new Error('model field should be a select');
    expect(select.options).toEqual([
      { value: 'claude-live-1', label: 'Claude Live', description: 'claude-live-1' },
    ]);
    // A stored model that the account cannot use must not stay selected.
    expect(select.defaultValue).toBe('claude-live-1');
    expect(field(form, 'apiKey')).toMatchObject({ placeholder: '(set)' });
  });

  it('keeps the stored model selected when the API still offers it', async () => {
    const cfg = config();
    cfg.anthropic.model = 'claude-live-2';
    saveConfig(cfg);
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-test' });
    respondModels({ data: [{ id: 'claude-live-1' }, { id: 'claude-live-2' }] });

    expect(field(await section('anthropic'), 'model')).toMatchObject({
      defaultValue: 'claude-live-2',
    });
  });

  it('saves the model, and the key only when one was typed', async () => {
    const form = await section('anthropic');

    expect(await submitText(form, { model: '  claude-opus-5  ', apiKey: '   ' })).toBe(
      '✓ Anthropic settings saved',
    );
    expect(config().anthropic.model).toBe('claude-opus-5');
    expect(secrets().ANTHROPIC_API_KEY).toBeUndefined();

    expect(await submitText(form, { model: 'claude-opus-5', apiKey: ' sk-typed ' })).toContain(
      'key updated',
    );
    expect(secrets().ANTHROPIC_API_KEY).toBe('sk-typed');
  });

  it('does not clear an existing key when the field is left empty', async () => {
    saveSecrets({ ANTHROPIC_API_KEY: 'sk-existing' });
    respondModels({ data: [{ id: 'claude-live-1' }] });
    await submitText(await section('anthropic'), { model: 'claude-live-1', apiKey: '' });
    expect(secrets().ANTHROPIC_API_KEY).toBe('sk-existing');
  });
});

describe('/config telegram', () => {
  withTempHome('config-telegram');

  it('stores the whole section, parsing the allowlist out of a comma string', async () => {
    const out = await submitText(await section('telegram'), {
      enabled: 'yes',
      allowedUserIds: ' 111, 222 ,333 ',
      streamMode: 'Stream',
      streamThrottleMs: '1500',
      parseMode: 'PLAIN',
      token: '',
    });

    expect(out).toBe('✓ Telegram settings saved (restart daemon to apply)');
    expect(config().bots.telegram).toMatchObject({
      enabled: true,
      allowedUserIds: [111, 222, 333],
      streamMode: 'stream',
      streamThrottleMs: 1500,
      parseMode: 'plain',
    });
  });

  it('drops allowlist entries that are not positive numbers', async () => {
    await submitText(await section('telegram'), { allowedUserIds: 'abc, , -5, 0, 42' });
    expect(config().bots.telegram.allowedUserIds).toEqual([42]);
  });

  it('falls back to safe values for an unknown stream mode and parse mode', async () => {
    await submitText(await section('telegram'), { streamMode: 'firehose', parseMode: 'markdown' });
    expect(config().bots.telegram.streamMode).toBe('final');
    expect(config().bots.telegram.parseMode).toBe('html');
  });

  it('ignores a throttle outside the documented 250–10000 range', async () => {
    const before = config().bots.telegram.streamThrottleMs;
    for (const bad of ['249', '10001', 'soon', '']) {
      await submitText(await section('telegram'), { streamThrottleMs: bad });
      expect(config().bots.telegram.streamThrottleMs).toBe(before);
    }
    await submitText(await section('telegram'), { streamThrottleMs: '250' });
    expect(config().bots.telegram.streamThrottleMs).toBe(250);
    await submitText(await section('telegram'), { streamThrottleMs: '10000' });
    expect(config().bots.telegram.streamThrottleMs).toBe(10000);
  });

  it('saves a typed token and reports it separately', async () => {
    expect(await submitText(await section('telegram'), { token: ' 123:ABC ' })).toContain(
      'token updated',
    );
    expect(secrets().ASTERISK_TELEGRAM_BOT_TOKEN).toBe('123:ABC');
    // And an empty token leaves it alone.
    await submitText(await section('telegram'), { token: '  ' });
    expect(secrets().ASTERISK_TELEGRAM_BOT_TOKEN).toBe('123:ABC');
  });

  it('prefills from the stored settings, including whether a token exists', async () => {
    const cfg = config();
    cfg.bots.telegram.enabled = true;
    cfg.bots.telegram.allowedUserIds = [7, 8];
    saveConfig(cfg);
    saveSecrets({ ASTERISK_TELEGRAM_BOT_TOKEN: '123:ABC' });

    const form = await section('telegram');
    expect(field(form, 'enabled')).toMatchObject({ defaultValue: 'yes' });
    expect(field(form, 'allowedUserIds')).toMatchObject({ defaultValue: '7,8' });
    expect(field(form, 'token')).toMatchObject({ secret: true, placeholder: '(set)' });
  });
});

describe('/config with an empty submission', () => {
  withTempHome('config-empty');

  it('keeps every stored value rather than blanking the section', async () => {
    const before = JSON.stringify(config());
    for (const name of ['provider', 'openai-compatible', 'anthropic', 'telegram', 'daemon']) {
      const form = await section(name);
      expect(await submitText(form, {}), name).toContain('✓');
    }
    const after = config();
    const previous = JSON.parse(before) as ReturnType<typeof config>;
    expect(after.provider).toBe(previous.provider);
    expect(after.openaiCompatible).toEqual(previous.openaiCompatible);
    expect(after.anthropic).toEqual(previous.anthropic);
    expect(after.daemon).toEqual(previous.daemon);
  });
});

describe('/config cancelling', () => {
  withTempHome('config-cancel');

  it('leaves every section untouched', async () => {
    const before = JSON.stringify(config());
    for (const name of ['provider', 'openai-compatible', 'anthropic', 'telegram', 'daemon']) {
      const form = await section(name);
      expect(await form.onCancel?.(), name).toBe('(cancelled)');
    }
    expect(JSON.stringify(config())).toBe(before);
  });
});

describe('/config daemon', () => {
  withTempHome('config-daemon');

  it('stores the log level and a heartbeat at or above the floor', async () => {
    await submitText(await section('daemon'), { logLevel: 'debug', heartbeatSeconds: '5' });
    expect(config().daemon).toMatchObject({ logLevel: 'debug', heartbeatSeconds: 5 });
  });

  it('ignores a heartbeat below the 5s floor or not a number', async () => {
    const before = config().daemon.heartbeatSeconds;
    for (const bad of ['4', '0', 'often', '']) {
      await submitText(await section('daemon'), { heartbeatSeconds: bad });
      expect(config().daemon.heartbeatSeconds).toBe(before);
    }
  });

  it('offers every pino level the schema accepts', async () => {
    const select = field(await section('daemon'), 'logLevel');
    if (select.kind !== 'select') throw new Error('logLevel should be a select');
    expect(select.options.map((o) => o.value)).toEqual([
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────

const hooks = (): HookConfig[] => config().hooks;

function seedHooks(...entries: HookConfig[]): void {
  const cfg = config();
  cfg.hooks = entries;
  saveConfig(cfg);
}

const hook = (name: string, enabled = true): HookConfig => ({
  name,
  event: 'after_tool',
  command: `echo ${name}`,
  timeoutSeconds: 30,
  enabled,
});

describe('/hooks routing', () => {
  withTempHome('hooks');

  it('rejects an unknown verb', async () => {
    expect(await runText(makeContext(), '/hooks', 'lst')).toBe('unknown /hooks verb: lst');
  });

  it('routes every entry of the action picker', async () => {
    const picker = await runList(makeContext(), '/hooks');
    expect(values(picker)).toEqual(['list', 'add', 'toggle', 'remove']);
    expect(asText(await picker.onPick('list'))).toContain('No hooks configured.');
    expect(asForm(await picker.onPick('add')).title).toBe('Add a hook');
    expect(asList(await picker.onPick('toggle')).title).toMatch(/Toggle which/);
    expect(asList(await picker.onPick('remove')).title).toMatch(/Remove which/);
    expect(await picker.onPick('nonsense')).toBeNull();
    expect(picker.onCancel?.()).toBeNull();
  });

  it('explains what hooks are when none are configured', async () => {
    const out = await runText(makeContext(), '/hooks', 'list');
    expect(out).toContain('No hooks configured.');
    expect(out).toContain('before_tool');
    expect(out).toContain('/hooks add');
  });

  it('lists each hook with its state, event and command', async () => {
    seedHooks(hook('lint'), { ...hook('notify', false), event: 'on_error', matcher: '^Write$' });
    const out = await runText(makeContext(), '/hooks', 'list');

    expect(out).toContain('Hooks  2 configured');
    const line = (name: string): string => out.split('\n').find((l) => l.includes(name)) ?? '';
    expect(line('lint').trim().startsWith('●')).toBe(true);
    expect(line('notify').trim().startsWith('○')).toBe(true);
    expect(line('notify')).toContain('on_error');
    expect(line('notify')).toContain('/^Write$/');
    expect(out).toContain('echo lint');
  });
});

describe('/hooks add', () => {
  withTempHome('hooks-add');

  it('stores a hook with every field the form collected', async () => {
    const form = await runForm(makeContext(), '/hooks', 'add');
    expect(keys(form)).toEqual([
      'name',
      'event',
      'matcher',
      'command',
      'timeoutSeconds',
      'enabled',
    ]);

    const out = await submitText(form, {
      name: '  lint-on-write  ',
      event: 'before_tool',
      matcher: '  ^Write|Edit$  ',
      command: '  biome check --write  ',
      timeoutSeconds: '15',
      enabled: 'no',
    });

    expect(out).toBe('✓ added hook "lint-on-write" (before_tool / ^Write|Edit$)');
    expect(hooks()).toEqual([
      {
        name: 'lint-on-write',
        event: 'before_tool',
        matcher: '^Write|Edit$',
        command: 'biome check --write',
        timeoutSeconds: 15,
        enabled: false,
      },
    ]);
  });

  it('omits the matcher entirely when it is left blank', async () => {
    const form = await runForm(makeContext(), '/hooks', 'add');
    const out = await submitText(form, { name: 'plain', command: 'true', matcher: '   ' });
    expect(out).toBe('✓ added hook "plain" (after_tool)');
    expect(hooks()[0]).not.toHaveProperty('matcher');
  });

  it('defaults the event, timeout and enabled flag', async () => {
    await submitText(await runForm(makeContext(), '/hooks', 'add'), {
      name: 'defaults',
      command: 'true',
    });
    expect(hooks()[0]).toMatchObject({ event: 'after_tool', timeoutSeconds: 30, enabled: true });
  });

  it('falls back to a 30s timeout when the value is not a positive number', async () => {
    for (const bad of ['0', '-5', 'soon']) {
      seedHooks();
      await submitText(await runForm(makeContext(), '/hooks', 'add'), {
        name: 'x',
        command: 'true',
        timeoutSeconds: bad,
      });
      expect(hooks()[0]?.timeoutSeconds).toBe(30);
    }
  });

  it('refuses a blank name and a duplicate one without touching the stored hooks', async () => {
    seedHooks(hook('lint'));
    const form = await runForm(makeContext(), '/hooks', 'add');

    expect(await submitText(form, { name: '  ', command: 'true' })).toBe('name is required');
    expect(await submitText(form, {})).toBe('name is required');
    expect(await submitText(form, { name: 'lint', command: 'other' })).toBe(
      'hook "lint" already exists',
    );
    expect(hooks()).toHaveLength(1);
    expect(hooks()[0]?.command).toBe('echo lint');
  });

  it('cancelling writes nothing', async () => {
    const form = await runForm(makeContext(), '/hooks', 'add');
    expect(await form.onCancel?.()).toBe('(cancelled)');
    expect(hooks()).toEqual([]);
  });
});

describe('/hooks toggle and remove', () => {
  withTempHome('hooks-edit');

  it('toggle flips the stored flag both ways', async () => {
    seedHooks(hook('lint'));
    expect(await runText(makeContext(), '/hooks', 'toggle lint')).toBe('✓ "lint" is now disabled');
    expect(hooks()[0]?.enabled).toBe(false);
    expect(await runText(makeContext(), '/hooks', 'toggle lint')).toBe('✓ "lint" is now enabled');
    expect(hooks()[0]?.enabled).toBe(true);
  });

  it('toggle names a hook that is not there', async () => {
    expect(await runText(makeContext(), '/hooks', 'toggle ghost')).toBe('no hook named "ghost"');
  });

  it('the toggle picker shows each hook state and applies the pick', async () => {
    const empty = await runList(makeContext(), '/hooks', 'toggle');
    expect(empty.emptyMessage).toBe('No hooks configured.');

    seedHooks(hook('lint'), hook('notify', false));
    const picker = await runList(makeContext(), '/hooks', 'toggle');
    expect(values(picker)).toEqual(['lint', 'notify']);
    expect(picker.items[0]?.description).toBe('after_tool · enabled');
    expect(picker.items[1]?.description).toBe('after_tool · disabled');

    expect(asText(await picker.onPick('notify'))).toBe('✓ "notify" is now enabled');
    expect(hooks()[1]?.enabled).toBe(true);
    expect(picker.onCancel?.()).toBeNull();
  });

  it('remove deletes only after the confirm says yes', async () => {
    seedHooks(hook('lint'), hook('notify'));

    const kept = await runForm(makeContext(), '/hooks', 'remove lint');
    expect(await submitText(kept, { confirm: 'no' })).toBe('(kept)');
    expect(hooks()).toHaveLength(2);

    const removed = await runForm(makeContext(), '/hooks', 'remove lint');
    expect(await submitText(removed, { confirm: 'yes' })).toBe('✓ removed hook "lint"');
    expect(hooks().map((h) => h.name)).toEqual(['notify']);
  });

  it('remove reports a name that is not there', async () => {
    seedHooks(hook('lint'));
    const form = await runForm(makeContext(), '/hooks', 'remove ghost');
    expect(await submitText(form, { confirm: 'yes' })).toBe('no hook named "ghost"');
    expect(hooks()).toHaveLength(1);
  });

  it('the remove picker shows event and command, and applies the pick', async () => {
    const empty = await runList(makeContext(), '/hooks', 'remove');
    expect(empty.emptyMessage).toBe('No hooks configured.');

    seedHooks(hook('lint'));
    const picker = await runList(makeContext(), '/hooks', 'remove');
    expect(picker.items[0]?.description).toBe('after_tool · echo lint');
    const confirm = asForm(await picker.onPick('lint'));
    expect(confirm.title).toBe('Remove hook "lint"?');
    expect(await submitText(confirm, { confirm: 'yes' })).toBe('✓ removed hook "lint"');
    expect(hooks()).toEqual([]);
    expect(picker.onCancel?.()).toBeNull();
  });

  it('cancelling the confirm keeps the hook', async () => {
    seedHooks(hook('lint'));
    const form = await runForm(makeContext(), '/hooks', 'remove lint');
    expect(await form.onCancel?.()).toBe('(cancelled)');
    expect(hooks()).toHaveLength(1);
  });

  it('/hooks with no verb never reaches the fallback branch', async () => {
    // Guards the routing: an empty argument opens the picker, it does not
    // report an unknown verb built from an empty string.
    const result = await run(makeContext(), '/hooks', '   ');
    expect(asList(result).title).toBe('Hooks — pick an action');
  });
});
