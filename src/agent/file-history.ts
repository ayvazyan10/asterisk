import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

interface FileSnapshot {
  path: string;
  timestamp: number;
  tool: string;
  backupPath: string;
}

const snapshots: FileSnapshot[] = [];
let seqCounter = 0;

function historyDir(): string {
  const dir = join(
    process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'),
    'file-history',
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function recordFileChange(filePath: string, tool: string): void {
  if (!existsSync(filePath)) return;
  const dir = historyDir();
  const ts = Date.now();
  const safe = basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const backupPath = join(dir, `${ts}-${seqCounter++}-${safe}`);
  try {
    copyFileSync(filePath, backupPath);
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

export function restoreFile(backupPath: string): { restored: boolean; path?: string; error?: string } {
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
