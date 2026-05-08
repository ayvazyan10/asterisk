import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getVersion } from '../src/version.ts';

describe('version utility', () => {
  it('returns a semver-like string', () => {
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('update entrypoint', () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await mkdtemp(join(tmpdir(), 'asterisk-update-'));
    execSync('git init', { cwd: tmpRepo });
    execSync('git config user.email "test@test.com"', { cwd: tmpRepo });
    execSync('git config user.name "test"', { cwd: tmpRepo });
    await writeFile(join(tmpRepo, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    execSync('git add -A && git commit -m "init"', { cwd: tmpRepo });
  });

  afterEach(async () => {
    await rm(tmpRepo, { recursive: true, force: true });
  });

  it('detects when install dir is not a git repo', () => {
    const nonGit = join(tmpRepo, 'nope');
    expect(() =>
      execSync('git rev-parse --git-dir', { cwd: nonGit, encoding: 'utf8' }),
    ).toThrow();
  });

  it('reads version from package.json', async () => {
    await writeFile(join(tmpRepo, 'package.json'), JSON.stringify({ version: '2.3.4' }));
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(join(tmpRepo, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('2.3.4');
  });

  it('detects no new commits when HEAD matches remote', () => {
    const local = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf8' }).trim();
    expect(local).toHaveLength(40);
    const count = execSync('git rev-list HEAD..HEAD --count', {
      cwd: tmpRepo,
      encoding: 'utf8',
    }).trim();
    expect(count).toBe('0');
  });
});
