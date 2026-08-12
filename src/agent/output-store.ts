import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ensureOwnerOnlyDir, writeOwnerOnly } from '../utils/fs-safe.ts';

const OUTPUT_THRESHOLD = 8192;
const PREVIEW_CHARS = 500;

export function shouldPersistOutput(output: string): boolean {
  return output.length > OUTPUT_THRESHOLD;
}

export function persistOutput(toolName: string, output: string): string {
  const dir = join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'outputs');
  ensureOwnerOnlyDir(dir);
  const ts = Date.now();
  const safe = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Concurrency-safe tools run under Promise.all, so two large results can land
  // in the same millisecond. Without the random suffix the second overwrites the
  // first and the model is handed a path to the wrong content.
  const filename = `${ts}-${randomBytes(4).toString('hex')}-${safe}.txt`;
  const path = join(dir, filename);
  writeOwnerOnly(path, output);
  const lines = output.split('\n').length;
  const preview = output.slice(0, PREVIEW_CHARS);
  return `[output persisted to ${path} — ${output.length} bytes, ${lines} lines. First ${PREVIEW_CHARS} chars shown below]\n${preview}`;
}
