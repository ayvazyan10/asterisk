// `/doctor` — environment diagnostics.
//
// Checks provider connectivity, the system tools the agent shells out to, MCP
// servers, config files and daemon status. Split out of registry.ts to keep it
// under the repo's 800-line limit. Pure move — no behaviour changed.

import { existsSync } from 'node:fs';

import { loadConfig } from '../config/load.ts';
import { asteriskPaths } from '../daemon/paths.ts';
import { statusFromPidFile } from '../daemon/pidfile.ts';
import { detectActiveModel } from '../providers/model-detect.ts';
import { sandboxStatus } from '../tools/sandbox.ts';
import { parseProviderName } from './models.ts';
import type { SlashCommand } from './registry.ts';

export const doctorCommand: SlashCommand = {
  name: '/doctor',
  description: 'Run diagnostics on Asterisk environment',
  async execute(ctx) {
    const lines: string[] = ['Asterisk diagnostics', ''];
    const paths = asteriskPaths();
    // Recorded before anything calls loadConfig(): the first load absorbs a
    // legacy config.json and renames it config.json.migrated, so checking later
    // always reported "using defaults" on exactly the install that had one.
    // /status gets this right by checking first; /doctor did not.
    const hadConfigFile = existsSync(paths.configFile);

    // Provider
    const current = parseProviderName(ctx.provider.name);
    lines.push(`Provider     ${ctx.provider.name}`);

    // Local endpoint: is it up, and what is it serving? The second half is
    // the useful part now that the model name is detected rather than
    // configured — "reachable" with no model loaded is still a broken setup.
    const localBase = loadConfig().config.openaiCompatible.baseUrl;
    try {
      const detected = await detectActiveModel(localBase, '', { force: true, timeoutMs: 3000 });
      if (detected) {
        const window = detected.contextWindow
          ? ` · ${detected.contextWindow.toLocaleString('en-US')} ctx`
          : '';
        lines.push(`  ✓ Local      ${localBase} · serving ${detected.id}${window}`);
      } else {
        lines.push(`  ✗ Local      ${localBase} reachable but reported no model`);
      }
    } catch {
      lines.push(`  ✗ Local      unreachable at ${localBase}`);
    }

    // Anthropic key
    const apiKey = loadConfig().secrets.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(5000),
        });
        lines.push(
          res.ok ? '  ✓ Anthropic  API key valid' : `  ✗ Anthropic  API returned ${res.status}`,
        );
      } catch {
        lines.push('  ✗ Anthropic  API unreachable');
      }
    } else {
      lines.push('  · Anthropic  no API key set');
    }

    lines.push('');

    // System tools
    const { execSync } = await import('node:child_process');
    const checkBin = (name: string, cmd: string): string => {
      try {
        const ver = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
        return `  ✓ ${name.padEnd(12)} ${ver}`;
      } catch {
        return `  ✗ ${name.padEnd(12)} not found`;
      }
    };
    lines.push('System tools');
    lines.push(checkBin('git', 'git --version'));
    lines.push(checkBin('rg', 'rg --version'));
    lines.push(checkBin('bun', 'bun --version'));
    lines.push(checkBin('node', 'node --version'));

    // Playwright. Resolved, never executed: `npx playwright --version` reaches
    // for the registry when the package is absent, which is now the ordinary
    // case since it became an optional peer — so the probe meant to report a
    // missing package was the slowest thing in /doctor, and on a cold cache it
    // outlived its own 5s timeout. This asks the resolver the same question
    // the lazy import in tools/browser/session.ts asks, and answers instantly.
    try {
      import.meta.resolve('playwright');
      lines.push('  ✓ playwright  installed');
    } catch {
      lines.push('  · playwright  not found — optional; browser tools are disabled until you run');
      lines.push('                bun add playwright && bunx playwright install chromium');
    }

    lines.push('');

    // MCP
    const mcpCfg = loadConfig().config.mcpServers;
    const mcpConnected = ctx.mcp.servers.length;
    const mcpTools = ctx.mcp.tools.length;
    lines.push(`MCP          ${mcpConnected}/${mcpCfg.length} servers · ${mcpTools} tools`);

    // Security posture. Two separate questions, and users conflate them:
    // permissions decide whether a command runs, the sandbox decides what it
    // can reach once it does.
    const perms = loadConfig().config.permissions;
    const sandbox = await sandboxStatus();
    lines.push('');
    lines.push('Security');
    lines.push(
      `  ${perms.mode === 'unrestricted' ? '✗' : '✓'} Bash perms mode ${perms.mode} · unattended runs ${perms.headless}`,
    );
    lines.push(
      sandbox.backend === 'none'
        ? `  ✗ Sandbox    none — ${sandbox.reason}`
        : `  ✓ Sandbox    ${sandbox.backend} — ${sandbox.reason}`,
    );

    // Config files
    lines.push('');
    lines.push('Config files');
    lines.push(
      hadConfigFile
        ? `  ✓ config     ${paths.configFile}`
        : `  · config     ${paths.configFile} (using defaults)`,
    );
    lines.push(
      existsSync(paths.secretsFile)
        ? `  ✓ secrets    ${paths.secretsFile}`
        : `  · secrets    ${paths.secretsFile} (not created)`,
    );

    // Daemon
    const pid = statusFromPidFile(paths.pidFile);
    lines.push('');
    lines.push(pid.running ? `Daemon       running · pid ${pid.pid}` : 'Daemon       not running');

    // History
    lines.push(`History      ${ctx.state.history.length} messages`);

    return lines.join('\n');
  },
};
