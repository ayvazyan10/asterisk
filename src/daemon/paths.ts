// Filesystem paths used by the daemon. All under ~/.asterisk by default;
// override the root via ASTERISK_HOME.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AsteriskPaths {
  root: string;
  pidFile: string;
  logsDir: string;
  daemonLog: string;
  configFile: string;
  secretsFile: string;
  whatsappSession: string;
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
    whatsappSession: join(root, 'whatsapp-web-session'),
  };
}

export function ensurePaths(p: AsteriskPaths): void {
  mkdirSync(p.root, { recursive: true });
  mkdirSync(p.logsDir, { recursive: true });
}
