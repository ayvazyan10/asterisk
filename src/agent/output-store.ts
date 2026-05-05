import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUTPUT_THRESHOLD = 8192;
const PREVIEW_CHARS = 500;

export function shouldPersistOutput(output: string): boolean {
  return output.length > OUTPUT_THRESHOLD;
}

export function persistOutput(toolName: string, output: string): string {
  const dir = join(process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'), 'outputs');
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const safe = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${ts}-${safe}.txt`;
  const path = join(dir, filename);
  writeFileSync(path, output, 'utf8');
  const lines = output.split('\n').length;
  const preview = output.slice(0, PREVIEW_CHARS);
  return `[output persisted to ${path} — ${output.length} bytes, ${lines} lines. First ${PREVIEW_CHARS} chars shown below]\n${preview}`;
}
