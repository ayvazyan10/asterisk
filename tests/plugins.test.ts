// Loading plugins, and the far more important business of not loading them.
//
// A plugin is a TypeScript module imported into the agent's process: it runs
// with the SQLite store holding the API keys, the tool registry and the
// permission gate itself. Nothing confines it — the sandbox confines child
// processes, and a plugin is a function call. So the assertions that matter
// most here are the refusals: off by default, no directory scan, nothing
// loaded that was not named in configuration.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPlugins, runPluginHandlers } from '../src/plugins/loader.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asterisk-plugins-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a plugin module and returns its path. */
async function plugin(name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.ts`);
  await writeFile(path, body);
  return path;
}

const TOOL_PLUGIN = `
export default {
  name: 'greeter',
  description: 'adds a greeting tool',
  register(api) {
    api.registerTool({
      name: 'Greet',
      description: 'says hello',
      input_schema: { type: 'object', properties: {} },
      async execute() {
        return { output: 'hello', isError: false };
      },
    });
    api.log('registered Greet');
  },
};
`;

describe('loadPlugins — refusing to load', () => {
  it('loads nothing when disabled, even with paths listed', async () => {
    const path = await plugin('greeter', TOOL_PLUGIN);
    const result = await loadPlugins([path], false);

    // The default is off precisely so a config carried between machines
    // cannot start executing code by arriving somewhere new.
    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('loads nothing when no paths are listed', async () => {
    // There is no directory scan anywhere in the loader: dropping a file into
    // a folder must never be enough to get code into this process.
    await plugin('greeter', TOOL_PLUGIN);
    const result = await loadPlugins([], true);
    expect(result.plugins).toHaveLength(0);
  });

  it('reports a module that exports no plugin rather than importing it blindly', async () => {
    const path = await plugin('empty', 'export const somethingElse = 1;');
    const result = await loadPlugins([path], true);

    expect(result.plugins).toHaveLength(0);
    expect(result.errors[0]).toContain('no plugin exported');
    expect(result.errors[0]).toContain(path);
  });

  it('reports a module that throws on import, and keeps going', async () => {
    const bad = await plugin('bad', 'throw new Error("boom at import time");');
    const good = await plugin('greeter', TOOL_PLUGIN);

    const result = await loadPlugins([bad, good], true);

    // A broken third-party file must not cost the user their REPL.
    expect(result.errors[0]).toContain('boom at import time');
    expect(result.plugins.map((p) => p.name)).toEqual(['greeter']);
  });

  it('reports a plugin whose register() throws', async () => {
    const path = await plugin(
      'thrower',
      `export default { name: 'thrower', register() { throw new Error('bad register'); } };`,
    );
    const result = await loadPlugins([path], true);
    expect(result.plugins).toHaveLength(0);
    expect(result.errors[0]).toContain('bad register');
  });

  it('refuses a plugin missing name or register', async () => {
    const noName = await plugin('a', 'export default { register() {} };');
    const noRegister = await plugin('b', "export default { name: 'b' };");
    const blankName = await plugin('c', `export default { name: '  ', register() {} };`);

    const result = await loadPlugins([noName, noRegister, blankName], true);
    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
  });

  it('loads a duplicated path once and says so', async () => {
    // Loading twice would register the tool twice, and the second copy would
    // be unreachable behind the first in getTool().
    const path = await plugin('greeter', TOOL_PLUGIN);
    const result = await loadPlugins([path, path], true);

    expect(result.plugins).toHaveLength(1);
    expect(result.errors[0]).toContain('more than once');
  });

  it('ignores blank entries', async () => {
    const result = await loadPlugins(['', '   '], true);
    expect(result.plugins).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('loadPlugins — what a plugin can do', () => {
  it('registers a tool', async () => {
    const path = await plugin('greeter', TOOL_PLUGIN);
    const result = await loadPlugins([path], true);

    expect(result.plugins[0]?.tools.map((t) => t.name)).toEqual(['Greet']);
    const output = await result.plugins[0]?.tools[0]?.execute({});
    expect(output?.output).toBe('hello');
  });

  it('tags its log lines with its own name', async () => {
    const path = await plugin('greeter', TOOL_PLUGIN);
    const result = await loadPlugins([path], true);
    expect(result.notices[0]).toBe('[greeter] registered Greet');
  });

  it('refuses registerTool called with something that is not a tool', async () => {
    const path = await plugin(
      'sloppy',
      `export default { name: 'sloppy', register(api) { api.registerTool({ name: 'X' }); } };`,
    );
    const result = await loadPlugins([path], true);
    expect(result.plugins).toHaveLength(0);
    expect(result.errors[0]).toContain('not a tool');
  });

  it('accepts an async register', async () => {
    const path = await plugin(
      'later',
      `export default {
         name: 'later',
         async register(api) {
           await Promise.resolve();
           api.log('done');
         },
       };`,
    );
    const result = await loadPlugins([path], true);
    expect(result.plugins).toHaveLength(1);
    expect(result.notices[0]).toContain('done');
  });

  it('accepts a named `plugin` export as well as default', async () => {
    const path = await plugin(
      'named',
      `export const plugin = { name: 'named', register(api) { api.log('hi'); } };`,
    );
    const result = await loadPlugins([path], true);
    expect(result.plugins[0]?.name).toBe('named');
  });
});

describe('runPluginHandlers', () => {
  const withHandler = (name: string, body: string) => ({
    name,
    path: `/fake/${name}`,
    tools: [],
    handlers: [{ event: 'before_tool' as const, run: new Function('ctx', body) as never }],
  });

  it('blocks a tool call and names the plugin that did it', async () => {
    const plugins = [
      withHandler('guard', `return { action: 'block', reason: 'not on my watch' };`),
    ];
    const { decision } = await runPluginHandlers(plugins, { event: 'before_tool', tool: 'Bash' });

    expect(decision).toMatchObject({ action: 'block' });
    // Attribution matters: "blocked" with no source is unactionable.
    expect((decision as { reason: string }).reason).toContain('guard');
    expect((decision as { reason: string }).reason).toContain('not on my watch');
  });

  it('lets the call through when no handler objects', async () => {
    const plugins = [withHandler('quiet', 'return undefined;')];
    const { decision } = await runPluginHandlers(plugins, { event: 'before_tool', tool: 'Bash' });
    expect(decision).toBeUndefined();
  });

  it('ignores handlers registered for a different event', async () => {
    const plugins = [withHandler('guard', `return { action: 'block', reason: 'no' };`)];
    const { decision } = await runPluginHandlers(plugins, { event: 'after_tool', tool: 'Bash' });
    expect(decision).toBeUndefined();
  });

  it('treats a throwing handler as no opinion, not as a block', async () => {
    // Shell hooks fail closed because a hook that cannot run is a policy that
    // cannot be evaluated. A plugin crashing is a bug in code the user already
    // chose to trust in-process; failing every tool call over it is worse.
    const plugins = [withHandler('crasher', "throw new Error('handler bug');")];
    const { decision, errors } = await runPluginHandlers(plugins, {
      event: 'before_tool',
      tool: 'Bash',
    });

    expect(decision).toBeUndefined();
    expect(errors[0]).toContain('handler bug');
    expect(errors[0]).toContain('crasher');
  });

  it('stops at the first block', async () => {
    const plugins = [
      withHandler('first', `return { action: 'block', reason: 'first' };`),
      withHandler('second', `throw new Error('should not run');`),
    ];
    const { decision, errors } = await runPluginHandlers(plugins, {
      event: 'before_tool',
      tool: 'Bash',
    });
    expect((decision as { reason: string }).reason).toContain('first');
    expect(errors).toHaveLength(0);
  });
});
