// Path helpers shared across tools.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` or `~/...` to the user's home directory. */
export function expandHome(path: string): string {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
