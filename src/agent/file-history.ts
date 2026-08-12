import { chmodSync, copyFileSync, existsSync } from 'node:fs';
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

function historyDir(): string {
  const dir = join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'file-history');
  ensureOwnerOnlyDir(dir);
  return dir;
}

export function recordFileChange(filePath: string, tool: string): void {
  if (!existsSync(filePath)) return;
  const dir = historyDir();
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
    if (snapshots.length > 200) snapshots.shift();
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
