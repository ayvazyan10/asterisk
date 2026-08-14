// What the running control panel is actually serving.
//
// The pid file answers "is it alive"; this answers "on which address". They
// are separate because the pid file format is shared with the daemon and is
// parsed positionally, and because the panel writes this one *after* the bind
// succeeds — its appearance is how the foreground child tells the parent that
// startup worked.
//
// The address is not derivable from the config: an instance started with
// `--port 8080` keeps serving 8080 after the configured port changes, and a
// message naming the wrong port is worse than no message.
//
// No token is stored here. `web/auth.ts` keeps SHA-256 hashes only, and
// writing a usable credential to disk would undo that.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { asteriskPaths } from '../daemon/paths.ts';
import { writeOwnerOnlyAtomic } from '../utils/fs-safe.ts';

export interface WebState {
  pid: number;
  url: string;
  host: string;
  port: number;
  authRequired: boolean;
  startedAt: number;
}

export function writeWebState(state: WebState): void {
  writeOwnerOnlyAtomic(asteriskPaths().webStateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/** Returns null when the file is missing, unreadable or not a valid record. */
export function readWebState(): WebState | null {
  const file = asteriskPaths().webStateFile;
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WebState>;
    if (typeof parsed.url !== 'string' || typeof parsed.port !== 'number') return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return null;
    return {
      pid: parsed.pid,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      authRequired: parsed.authRequired !== false,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearWebState(): void {
  try {
    const file = asteriskPaths().webStateFile;
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // A leftover file is harmless — the pid file is what decides liveness.
  }
}
