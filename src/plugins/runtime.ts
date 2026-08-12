// The process-wide plugin set.
//
// Loading is explicit — `initialisePlugins()` at startup — rather than lazy on
// first use. A lazy load would make the tool list change part-way through a
// session, which is exactly the kind of surprise you do not want from code
// running with your keys.
//
// Before initialisation everything here reports empty, so a caller that
// forgets to initialise gets Asterisk without plugins rather than a crash or a
// half-loaded set.

import { loadConfig } from '../config/load.ts';
import type { Tool } from '../tools/types.ts';
import { type LoadedPlugin, loadPlugins, pluginTools, runPluginHandlers } from './loader.ts';
import type { PluginDecision, PluginEventContext } from './types.ts';

let loaded: LoadedPlugin[] = [];
let report: { errors: string[]; notices: string[] } = { errors: [], notices: [] };

/**
 * Loads the configured plugins. Safe to call more than once; the second call
 * replaces the set rather than adding to it, so a `/reset` cannot end up with
 * two copies of every plugin tool.
 */
export async function initialisePlugins(): Promise<{ errors: string[]; notices: string[] }> {
  try {
    const { config } = loadConfig();
    const result = await loadPlugins(config.plugins.load, config.plugins.enabled);
    loaded = result.plugins;
    report = { errors: result.errors, notices: result.notices };
  } catch (e) {
    // Configuration unreadable — run without plugins rather than refusing to
    // start. Plugins are an add-on; the assistant is the product.
    loaded = [];
    report = { errors: [`plugins not loaded: ${(e as Error).message}`], notices: [] };
  }
  return report;
}

/** Tools contributed by loaded plugins. Empty before initialisation. */
export function activePluginTools(): Tool[] {
  return pluginTools(loaded);
}

/** What loaded, for `/plugins` and `/doctor`. */
export function activePlugins(): readonly LoadedPlugin[] {
  return loaded;
}

/** Errors and notices from the last load. */
export function pluginReport(): { errors: string[]; notices: string[] } {
  return report;
}

/** Runs plugin lifecycle handlers for one event. */
export async function firePluginEvent(
  ctx: PluginEventContext,
): Promise<{ decision: PluginDecision; errors: string[] }> {
  if (loaded.length === 0) return { decision: undefined, errors: [] };
  return await runPluginHandlers(loaded, ctx);
}

/** Test-only: drop the loaded set. */
export function _resetPluginsForTesting(): void {
  loaded = [];
  report = { errors: [], notices: [] };
}
