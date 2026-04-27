// Daemon logger — pino with a file destination, manual size-based rotation
// (single rolling backup, no extra dependency).

import { renameSync, statSync } from 'node:fs';
import pino, { type Logger } from 'pino';

const MAX_LOG_BYTES = 5_000_000;

export function createDaemonLogger(logFile: string): Logger {
  rotateIfLarge(logFile);
  const dest = pino.destination({ dest: logFile, sync: false, mkdir: true });
  return pino(
    {
      level: process.env['ASTERISK_LOG_LEVEL'] ?? 'info',
      base: { name: 'asterisk-daemon' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );
}

function rotateIfLarge(logFile: string): void {
  try {
    const s = statSync(logFile);
    if (s.size > MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // No file yet — nothing to rotate.
  }
}
