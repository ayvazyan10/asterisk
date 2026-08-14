// Where the installed tree actually lives.
//
// Both managed child processes — the daemon and the web control panel — are
// spawned as `bun <entry>` from this directory, and each picks the bundled
// entry when it exists and the source one otherwise. That resolution has to
// work in two very different layouts (source: src/daemon/…, bundled: dist/…),
// so it looks for the one marker both share rather than counting directories.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walk up from this file's location until we find package.json. Works in both
// source mode and bundled mode — the directory layout differs but the marker
// is the same.
export function findProjectRoot(startFile: string): string {
  let dir = dirname(startFile);
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to a sensible guess: the caller's directory two levels up.
  return resolve(dirname(startFile), '..', '..');
}

export const PROJECT_ROOT = findProjectRoot(fileURLToPath(import.meta.url));

/**
 * Resolves an entrypoint by name, preferring the build output.
 *
 * `name` is the basename shared by both layouts: `daemon` resolves to
 * `dist/daemon.js` when it exists and `src/entrypoints/daemon.ts` otherwise.
 *
 * `ASTERISK_ENTRY_FROM_SOURCE=1` skips `dist/` entirely. The test suite sets
 * it: `bun run test` runs before `bun run build`, so a developer's `dist/` is
 * routinely older than the source under test, and spawning it would exercise
 * the previous build while reporting on the current one.
 */
export function entrypointPath(name: string): string {
  const dist = resolve(PROJECT_ROOT, 'dist', `${name}.js`);
  if (process.env['ASTERISK_ENTRY_FROM_SOURCE'] !== '1' && existsSync(dist)) return dist;
  const tsx = resolve(PROJECT_ROOT, 'src', 'entrypoints', `${name}.tsx`);
  if (existsSync(tsx)) return tsx;
  return resolve(PROJECT_ROOT, 'src', 'entrypoints', `${name}.ts`);
}
