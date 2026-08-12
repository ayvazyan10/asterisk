// Release notes come out of CHANGELOG.md, so a bug here ships a release
// describing the wrong version — or an empty one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractReleaseNotes } from '../scripts/release-notes.ts';

const SAMPLE = `# Changelog

Preamble that belongs to nothing.

## [0.2.0] - 2026-08-12

### Added

- A thing.

### Fixed

- Another thing.

## [0.1.0] - 2026-04-27

Initial public release.

[0.2.0]: https://github.com/x/y/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/x/y/releases/tag/v0.1.0
`;

describe('extractReleaseNotes', () => {
  it('returns only the requested version', () => {
    const notes = extractReleaseNotes(SAMPLE, '0.2.0');
    expect(notes).toContain('- A thing.');
    expect(notes).toContain('- Another thing.');
    expect(notes).not.toContain('Initial public release');
    expect(notes).not.toContain('Preamble');
  });

  it('reads the last section without running past the end', () => {
    expect(extractReleaseNotes(SAMPLE, '0.1.0')).toBe('Initial public release.');
  });

  it('strips the link-reference block', () => {
    expect(extractReleaseNotes(SAMPLE, '0.1.0')).not.toContain('https://');
  });

  it('returns null for a version that was never written up', () => {
    expect(extractReleaseNotes(SAMPLE, '9.9.9')).toBeNull();
  });

  it('does not match a version by prefix', () => {
    expect(extractReleaseNotes(SAMPLE, '0.1')).toBeNull();
    expect(extractReleaseNotes(SAMPLE, '0.2.0-rc.1')).toBeNull();
  });

  it('finds the real changelog entry for the current package version', () => {
    // Guards the release workflow: a version bump without a changelog entry
    // fails here rather than at tag time.
    const root = resolve(__dirname, '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    const notes = extractReleaseNotes(changelog, pkg.version);
    expect(notes, `CHANGELOG.md has no section for ${pkg.version}`).not.toBeNull();
    expect(notes?.length ?? 0).toBeGreaterThan(100);
  });
});
