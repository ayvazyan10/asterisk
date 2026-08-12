import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../types/messages.ts';
import { ensureOwnerOnlyDir, writeOwnerOnlyAtomic } from '../utils/fs-safe.ts';
import { repairHistory } from './history.ts';

interface PersistedConversation {
  id: string;
  updatedAt: number;
  messages: Message[];
}

function persistDir(): string {
  const dir = join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'conversations');
  ensureOwnerOnlyDir(dir);
  return dir;
}

function filePath(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return join(persistDir(), `${safe}.json`);
}

export function saveConversation(id: string, messages: Message[]): void {
  const data: PersistedConversation = {
    id,
    updatedAt: Date.now(),
    messages,
  };
  try {
    // Atomic: a crash mid-write used to leave a truncated file, which
    // loadConversation reports as an empty history — silently losing the
    // conversation rather than failing loudly.
    writeOwnerOnlyAtomic(filePath(id), JSON.stringify(data));
  } catch {
    // best-effort
  }
}

export function loadConversation(id: string): Message[] {
  const path = filePath(id);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as PersistedConversation;
    if (!Array.isArray(data.messages)) return [];
    // Expire conversations older than 7 days
    if (Date.now() - data.updatedAt > 7 * 24 * 60 * 60 * 1000) {
      try {
        unlinkSync(path);
      } catch {}
      return [];
    }
    // Transcripts written before the abort path was fixed can hold tool_use
    // blocks that were never answered, which makes every turn of the restored
    // conversation fail with a non-retryable 400. Heal on the way in.
    return repairHistory(data.messages);
  } catch {
    return [];
  }
}

export function listConversations(): Array<{
  id: string;
  updatedAt: number;
  messageCount: number;
}> {
  const dir = persistDir();
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const result: Array<{ id: string; updatedAt: number; messageCount: number }> = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        const data = JSON.parse(raw) as PersistedConversation;
        result.push({
          id: data.id,
          updatedAt: data.updatedAt,
          messageCount: data.messages?.length ?? 0,
        });
      } catch {}
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function deleteConversation(id: string): boolean {
  const path = filePath(id);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
