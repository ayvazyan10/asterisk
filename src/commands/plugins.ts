// `/plugins` — what code is running inside this process.
//
// A plugin has the run of the place: the store holding your API keys, the tool
// registry, the permission gate. Code with that reach should not be silent
// about being there, and a startup line on stderr scrolls away. This is the
// answer to "what is loaded right now", available at any point in a session.

import { loadConfig } from '../config/load.ts';
import { activePlugins, pluginReport } from '../plugins/runtime.ts';
import type { SlashCommand } from './registry.ts';

export const pluginsCommand: SlashCommand = {
  name: '/plugins',
  description: 'List loaded plugins and anything that failed to load',
  execute() {
    const { config } = loadConfig();
    const loaded = activePlugins();
    const report = pluginReport();

    const lines = [`Plugins · ${config.plugins.enabled ? 'enabled' : 'disabled'}`];

    if (!config.plugins.enabled) {
      lines.push(
        '',
        'Plugins are off. They run in-process with full access to your secrets',
        'and tools — the sandbox does not confine them, because it confines child',
        'processes and a plugin is a function call. Turn them on only for code you',
        'wrote or read; for anything else use an MCP server, where the isolation is',
        'that it is a separate process.',
        '',
        `Configured but not loaded: ${config.plugins.load.length}`,
      );
      for (const path of config.plugins.load) lines.push(`  · ${path}`);
      return lines.join('\n');
    }

    lines.push('', `Loaded  ${loaded.length}`);
    for (const p of loaded) {
      const tools = p.tools.length > 0 ? ` · ${p.tools.map((t) => t.name).join(', ')}` : '';
      const hooks = p.handlers.length > 0 ? ` · ${p.handlers.length} handler(s)` : '';
      lines.push(`  ${p.name}${tools}${hooks}`);
      if (p.description) lines.push(`    ${p.description}`);
      lines.push(`    ${p.path}`);
    }

    if (report.errors.length > 0) {
      lines.push('', `Failed  ${report.errors.length}`);
      for (const e of report.errors) lines.push(`  ✗ ${e}`);
    }
    if (report.notices.length > 0) {
      lines.push('', 'Notices');
      for (const n of report.notices) lines.push(`  ${n}`);
    }

    return lines.join('\n');
  },
};
