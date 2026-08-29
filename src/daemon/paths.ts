// Filesystem paths used by the daemon. All under ~/.asterisk by default;
// override the root via ASTERISK_HOME.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { ensureOwnerOnlyDir } from '../utils/fs-safe.ts';

export interface AsteriskPaths {
  root: string;
  pidFile: string;
  logsDir: string;
  daemonLog: string;
  configFile: string;
  secretsFile: string;
  dbFile: string;
  /** The control panel is a second managed process, with its own pid file. */
  webPidFile: string;
  webLog: string;
  webStateFile: string;
  /** Voice messages downloaded for transcription, deleted once read. */
  audioDir: string;
  /** Images a user sent a bot, deleted once the turn that saw them is done. */
  imageDir: string;
}

export function asteriskPaths(): AsteriskPaths {
  const root = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  return {
    root,
    pidFile: join(root, 'asterisk.pid'),
    logsDir: join(root, 'logs'),
    daemonLog: join(root, 'logs', 'daemon.log'),
    configFile: join(root, 'config.json'),
    secretsFile: join(root, 'secrets.env'),
    dbFile: join(root, 'asterisk.db'),
    // Deliberately separate from the daemon's: `asterisk stop` must not take
    // the panel down with it, and `asterisk web stop` must not stop the bots.
    webPidFile: join(root, 'web.pid'),
    webLog: join(root, 'logs', 'web.log'),
    webStateFile: join(root, 'web.json'),
    audioDir: join(root, 'audio'),
    imageDir: join(root, 'images'),
  };
}

/**
 * Creates the state directories, owner-only.
 *
 * The whole tree is 0700: the database holds credentials, the logs hold tool
 * input at debug level, and the transcripts hold everything the agent has ever
 * been shown. None of it should be readable by other local users.
 */
export function ensurePaths(p: AsteriskPaths): void {
  ensureOwnerOnlyDir(p.root);
  ensureOwnerOnlyDir(p.logsDir);
}
