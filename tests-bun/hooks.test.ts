import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fireHooks } from '../src/hooks/runner.ts';

test('a hook that ignores 5 MiB of stdin resolves without an uncaught stream error', async () => {
  const previousHome = process.env['ASTERISK_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'asterisk-bun-hooks-'));
  process.env['ASTERISK_HOME'] = home;
  try {
    const results = await fireHooks(
      [
        {
          name: 'ignore-stdin',
          event: 'after_tool',
          command: 'true',
          timeoutSeconds: 2,
          enabled: true,
        },
      ],
      { event: 'after_tool', tool: 'Read', toolOutput: 'x'.repeat(5 * 1024 * 1024) },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
  } finally {
    if (previousHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
