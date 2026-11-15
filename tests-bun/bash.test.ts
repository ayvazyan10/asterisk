import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveConfig } from '../src/config/load.ts';
import { ConfigSchema } from '../src/config/schema.ts';
import { closeDb } from '../src/db/index.ts';
import { bashTool } from '../src/tools/bash.ts';

test('Bash executes an allowlisted echo in a temporary workspace with sandbox off', async () => {
  const previousHome = process.env['ASTERISK_HOME'];
  const previousWorkspace = process.env['ASTERISK_WORKSPACE'];
  const previousCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), 'asterisk-bun-bash-'));
  const workspace = mkdtempSync(join(tmpdir(), 'asterisk-bun-workspace-'));
  process.env['ASTERISK_HOME'] = home;
  process.env['ASTERISK_WORKSPACE'] = workspace;
  process.chdir(workspace);
  try {
    saveConfig(
      ConfigSchema.parse({
        permissions: { mode: 'allowlist', allow: ['echo'] },
        sandbox: { mode: 'off' },
      }),
    );
    const result = await bashTool.execute({ command: 'echo ok', timeoutSeconds: 2 });
    expect(result.output).toContain('exit=0');
    expect(result.output).toContain('ok');
    expect(result.isError).toBe(false);
  } finally {
    closeDb();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = previousHome;
    if (previousWorkspace === undefined) delete process.env['ASTERISK_WORKSPACE'];
    else process.env['ASTERISK_WORKSPACE'] = previousWorkspace;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
