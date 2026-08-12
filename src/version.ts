import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  let version = '0.0.0';
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version?: string;
    };
    version = pkg.version ?? '0.0.0';
  } catch {
    // Running from a bundle with no package.json alongside it.
  }
  cached = version;
  return version;
}
