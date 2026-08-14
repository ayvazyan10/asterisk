// Loading plugins, and refusing to load them by accident.
//
// See types.ts for the security position. The rules that follow from it:
//
//   * off unless `plugins.enabled` is true — an arbitrary-code-execution
//     surface does not get a permissive default;
//   * every plugin is named by path in configuration, and there is no
//     directory scan, so dropping a file into a folder can never be enough;
//   * a plugin that throws is reported and skipped, never fatal — a broken
//     third-party file must not cost you the REPL;
//   * what loaded is visible, because code running with your keys should not
//     be silent about it.

import { isAbsolute, resolve } from 'node:path';

import type { HookEvent } from '../config/schema.ts';
import type { Tool } from '../tools/types.ts';
import { expandHome } from '../utils/path.ts';
import type {
  AsteriskPlugin,
  PluginApi,
  PluginDecision,
  PluginEventContext,
  PluginModule,
} from './types.ts';

export interface LoadedPlugin {
  name: string;
  description?: string | undefined;
  path: string;
  tools: Tool[];
  handlers: Array<{
    event: HookEvent;
    run: (ctx: PluginEventContext) => Promise<PluginDecision>;
  }>;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  /** One line per plugin that could not be loaded, naming the file. */
  errors: string[];
  /** Lines plugins emitted through `api.log`, tagged with their name. */
  notices: string[];
}

function isPlugin(value: unknown): value is AsteriskPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<AsteriskPlugin>;
  return typeof p.name === 'string' && p.name.trim().length > 0 && typeof p.register === 'function';
}

/**
 * Loads the plugins named in `paths`.
 *
 * `enabled` is passed in rather than read here so the caller — and the tests —
 * decide, and so this module never reaches for configuration on its own.
 */
export async function loadPlugins(
  paths: readonly string[],
  enabled: boolean,
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { plugins: [], errors: [], notices: [] };
  if (!enabled || paths.length === 0) return result;

  const seen = new Set<string>();

  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Tested before resolve(), not after: resolve() *makes* a path absolute, so
    // `isAbsolute(resolve(x))` is true for every x and the check that used to
    // be written that way could never fire. What it was there to stop is a
    // relative path silently resolving against whatever directory the daemon
    // happened to be started in.
    const expanded = expandHome(trimmed);
    if (!isAbsolute(expanded)) {
      result.errors.push(`${trimmed}: plugin paths must be absolute (or start with ~/)`);
      continue;
    }
    const path = resolve(expanded);
    // Loading the same module twice would register its tools twice, and the
    // second copy would shadow the first in getTool().
    if (seen.has(path)) {
      result.errors.push(`${path}: listed more than once, loaded once`);
      continue;
    }
    seen.add(path);

    try {
      const loaded = await loadOne(path);
      result.plugins.push(loaded.plugin);
      result.notices.push(...loaded.notices);
    } catch (e) {
      // Named, not swallowed: a plugin that fails silently looks exactly like
      // a plugin that loaded and did nothing.
      result.errors.push(`${path}: ${(e as Error).message}`);
    }
  }

  return result;
}

async function loadOne(path: string): Promise<{ plugin: LoadedPlugin; notices: string[] }> {
  const module = (await import(path)) as PluginModule;
  const candidate = module.default ?? module.plugin;
  if (!isPlugin(candidate)) {
    throw new Error('no plugin exported — expected a default export with { name, register }');
  }

  const tools: Tool[] = [];
  const handlers: LoadedPlugin['handlers'] = [];
  const notices: string[] = [];

  const api: PluginApi = {
    registerTool(tool) {
      if (!tool?.name || typeof tool.execute !== 'function') {
        throw new Error('registerTool called with something that is not a tool');
      }
      tools.push(tool);
    },
    on(event, handler) {
      handlers.push({ event, run: handler });
    },
    log(message) {
      notices.push(`[${candidate.name}] ${message}`);
    },
  };

  await candidate.register(api);

  return {
    plugin: {
      name: candidate.name,
      description: candidate.description,
      path,
      tools,
      handlers,
    },
    notices,
  };
}

/** Every tool contributed by the loaded plugins, in load order. */
export function pluginTools(plugins: readonly LoadedPlugin[]): Tool[] {
  return plugins.flatMap((p) => p.tools);
}

/**
 * Runs the handlers registered for `ctx.event` and returns the first block.
 *
 * A handler that throws is reported and treated as no opinion rather than as a
 * block: shell hooks fail closed because a hook that cannot run is a policy
 * that cannot be evaluated, but a plugin crashing is a bug in code the user
 * already chose to trust in-process, and failing every tool call over it would
 * be a worse outcome than continuing.
 */
export async function runPluginHandlers(
  plugins: readonly LoadedPlugin[],
  ctx: PluginEventContext,
): Promise<{ decision: PluginDecision; errors: string[] }> {
  const errors: string[] = [];

  for (const plugin of plugins) {
    for (const handler of plugin.handlers) {
      if (handler.event !== ctx.event) continue;
      try {
        const decision = await handler.run(ctx);
        if (decision && decision.action === 'block') {
          return {
            decision: { action: 'block', reason: `${plugin.name}: ${decision.reason}` },
            errors,
          };
        }
      } catch (e) {
        errors.push(`[${plugin.name}] ${ctx.event} handler failed: ${(e as Error).message}`);
      }
    }
  }

  return { decision: undefined, errors };
}
