import { chmodSync, copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { OWNER_ONLY_FILE, ensureOwnerOnlyDir } from '../utils/fs-safe.ts';

interface FileSnapshot {
  path: string;
  timestamp: number;
  tool: string;
  backupPath: string;
}

const snapshots: FileSnapshot[] = [];
let seqCounter = 0;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let prunedOnce = false;

function historyDir(): string {
  const dir = join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'file-history');
  ensureOwnerOnlyDir(dir);
  return dir;
}

export function recordFileChange(filePath: string, tool: string): void {
  if (!existsSync(filePath)) return;
  const dir = historyDir();
  if (!prunedOnce) {
    prunedOnce = true;
    try {
      for (const name of readdirSync(dir)) {
        try {
          const backup = join(dir, name);
          if (Date.now() - statSync(backup).mtimeMs > RETENTION_MS) unlinkSync(backup);
        } catch {
          // best-effort — one unreadable or busy file doesn't stop the sweep
        }
      }
    } catch {
      // best-effort — the history dir may not exist yet
    }
  }
  const ts = Date.now();
  const safe = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const backupPath = join(dir, `${ts}-${seqCounter++}-${safe}`);
  try {
    // copyFileSync carries the *source* file's mode, so a snapshot of a
    // world-readable file stayed world-readable — and these are verbatim copies
    // of whatever the agent was about to overwrite, including .env files.
    copyFileSync(filePath, backupPath);
    chmodSync(backupPath, OWNER_ONLY_FILE);
    snapshots.push({ path: filePath, timestamp: ts, tool, backupPath });
    if (snapshots.length > 200) {
      const evicted = snapshots.shift();
      if (evicted) {
        try {
          unlinkSync(evicted.backupPath);
        } catch {
          // best-effort — an orphaned backup is harmless
        }
      }
    }
  } catch {
    // best-effort — don't fail the tool if backup fails
  }
}

export function getFileHistory(filePath?: string): FileSnapshot[] {
  if (filePath) return snapshots.filter((s) => s.path === filePath);
  return [...snapshots];
}

export function restoreFile(backupPath: string): {
  restored: boolean;
  path?: string;
  error?: string;
} {
  const snap = snapshots.find((s) => s.backupPath === backupPath);
  if (!snap) return { restored: false, error: 'backup not found in history' };
  if (!existsSync(backupPath)) return { restored: false, error: 'backup file missing from disk' };
  try {
    recordFileChange(snap.path, 'restore');
    copyFileSync(backupPath, snap.path);
    return { restored: true, path: snap.path };
  } catch (e) {
    return { restored: false, error: (e as Error).message };
  }
}
