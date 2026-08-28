// Grep tool: argv construction (dash-prefixed patterns must not be parsed
// as options) and exit-code handling (a real search error must not come
// back as ok()).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
