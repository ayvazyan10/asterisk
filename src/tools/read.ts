// Read tool — reads a file (text only), with optional line range.

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Tool, err, ok } from './types.ts';

const MAX_BYTES = 1_000_000;

export const readTool: Tool = {
  name: 'Read',
  description:
    'Read a text file. Returns the contents with line numbers. Optional offset (1-based) and limit. Refuses files larger than 1MB.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path.' },
      offset: { type: 'number', description: 'Optional 1-based start line.' },
      limit: { type: 'number', description: 'Optional max number of lines to return.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input) {
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    if (!path) return err('path is required');

    const offset = typeof input['offset'] === 'number' ? Math.max(1, input['offset']) : 1;
    const limit =
      typeof input['limit'] === 'number' ? Math.max(1, input['limit']) : Number.POSITIVE_INFINITY;

    try {
      const abs = resolve(path);
      const st = await stat(abs);
      if (!st.isFile()) return err(`not a regular file: ${path}`);
      if (st.size > MAX_BYTES) {
        return err(`file too large (${st.size} bytes); refuse to read >1MB`);
      }
      const buf = await readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) {
        return err('binary file (contains NUL bytes); refusing to read as text');
      }
      // Split on any of \r\n, \r or \n rather than \n alone: a CRLF file
      // split only on \n leaves a trailing \r on every line — invisible in
      // a terminal, but a real character in the string handed back to the
      // model. An agent composing a multi-line Edit oldString from what it
      // "saw" here naturally leaves that \r out, which used to make Edit's
      // exact-match search fail against every CRLF file. See edit.ts.
      const text = buf.toString('utf8');
      const lines = text.split(/\r\n|\r|\n/);
      if (/[\r\n]$/.test(text)) lines.pop();
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      if (slice.length === 0 && offset > 1) {
        return ok(`(offset ${offset} is past end of file; file has ${lines.length} lines)`);
      }
      const numbered = slice
        .map((line, i) => `${String(offset + i).padStart(5, ' ')}\t${line}`)
        .join('\n');
      return ok(numbered);
    } catch (e) {
      return err(`Read failed: ${(e as Error).message}`);
    }
  },
};
