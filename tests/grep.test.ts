// Grep tool: argv construction (dash-prefixed patterns must not be parsed
// as options) and exit-code handling (a real search error must not come
// back as ok()).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGrepArgs, grepTool } from '../src/tools/grep.ts';

describe('buildGrepArgs', () => {
  it('places -- before the pattern and path for ripgrep', () => {
    const args = buildGrepArgs(true, '-foo', '/some/path');
    // Without `--`, ripgrep parses "-foo" as "-f oo" (-f takes a
    // patterns-file argument) instead of a literal search term.
    expect(args).toEqual([
      '--line-number',
      '--no-heading',
      '--color=never',
      '--',
      '-foo',
      '/some/path',
    ]);
  });

  it('places -- before the pattern and path for the grep fallback', () => {
    const args = buildGrepArgs(false, '-foo', '/some/path');
    expect(args).toEqual(['-rn', '-E', '--', '-foo', '/some/path']);
  });

  it('passes the glob as --include before -- for the grep fallback', () => {
    expect(buildGrepArgs(false, '-foo', '/some/path', '*.ts')).toEqual([
      '-rn',
      '-E',
      '--include=*.ts',
      '--',
      '-foo',
      '/some/path',
    ]);
  });

  it('keeps -- after --glob for ripgrep', () => {
    const args = buildGrepArgs(true, '-foo', '/some/path', '*.ts');
    expect(args).toEqual([
      '--line-number',
      '--no-heading',
      '--color=never',
      '--glob',
      '*.ts',
      '--',
      '-foo',
      '/some/path',
    ]);
  });
});

describe('Grep binary detection and partial results', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    savedPath = process.env['PATH'];
    dir = await mkdtemp(join(tmpdir(), 'asterisk-grep-path-'));
    process.env['PATH'] = dir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    await rm(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('uses grep when rg is missing and passes the include glob', async () => {
    await writeFile(join(dir, 'grep'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const { grepTool: freshGrep } = await import('../src/tools/grep.ts');

    const result = await freshGrep.execute({ pattern: 'hello', path: '.', glob: '*.ts' });

    expect(result.isError).toBe(false);
    expect(result.output.split('\n')).toEqual(['-rn', '-E', '--include=*.ts', '--', 'hello', '.']);
  });

  it.each([0, 1])('caches the rg availability probe with exit code %s', async (exitCode) => {
    const probes = join(dir, 'probes');
    await writeFile(
      join(dir, 'rg'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'probe\\n' >> '${probes}'
  exit ${exitCode}
fi
printf 'matched\\n'
`,
      { mode: 0o755 },
    );
    await writeFile(join(dir, 'grep'), "#!/bin/sh\nprintf 'matched\\n'\n", { mode: 0o755 });
    const { grepTool: freshGrep } = await import('../src/tools/grep.ts');

    const first = await freshGrep.execute({ pattern: 'matched' });
    const second = await freshGrep.execute({ pattern: 'matched' });

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(await readFile(probes, 'utf8')).toBe('probe\n');
  });

  it.each([false, true])(
    'keeps partial matches and bounds warnings (long output: %s)',
    async (long) => {
      const matches = long ? 'm'.repeat(30001) : 'sample.txt:1:matched';
      const warning = long ? 'w'.repeat(1001) : 'private.txt: Permission denied';
      await writeFile(
        join(dir, 'rg'),
        `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s' '${matches}'
printf '%s' '${warning}' >&2
exit 2
`,
        { mode: 0o755 },
      );
      const { grepTool: freshGrep } = await import('../src/tools/grep.ts');

      const result = await freshGrep.execute({ pattern: 'matched' });

      expect(result.isError).toBe(false);
      expect(result.output).toBe(
        long
          ? `${matches.slice(0, 30000)}\n[truncated]\n[warnings: ${warning.slice(0, 1000)}…]`
          : `${matches}\n[warnings: ${warning}]`,
      );
    },
  );
});

describe('Grep tool', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'asterisk-grep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a dash-prefixed pattern instead of it being parsed as a flag', async () => {
    const file = join(dir, 'sample.txt');
    await writeFile(file, 'plain line\nvalue: -foo bar\nother line\n');

    const r = await grepTool.execute({ pattern: '-foo', path: file });

    expect(r.isError).toBe(false);
    expect(r.output).toContain('-foo bar');
    expect(r.output).not.toMatch(/No such file or directory/);
    expect(r.output).not.toMatch(/os error/);
  });

  it('reports "no matches" cleanly for a dash-prefixed pattern absent from the file', async () => {
    const file = join(dir, 'sample2.txt');
    await writeFile(file, 'nothing interesting here\n');

    const r = await grepTool.execute({ pattern: '-nope', path: file });

    expect(r.isError).toBe(false);
    expect(r.output).toBe('(no matches)');
  });

  it('surfaces a real search error as an error, never as a disguised ok()', async () => {
    const file = join(dir, 'sample3.txt');
    await writeFile(file, 'hello\n');

    // An unbalanced group is invalid in both ripgrep's and grep -E's regex
    // engines: guaranteed non-zero exit with something on stderr, so this
    // must never come back as a successful "(no matches)"-shaped result.
    const r = await grepTool.execute({ pattern: '(unbalanced', path: file });

    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/Grep failed/);
  });

  it('finds an ordinary pattern (regression: normal search still works)', async () => {
    const file = join(dir, 'sample4.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\n');

    const r = await grepTool.execute({ pattern: 'beta', path: file });

    expect(r.isError).toBe(false);
    expect(r.output).toContain('beta');
  });
});
