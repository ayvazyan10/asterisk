// Write tool — overwrites or creates a file with the given content.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type Tool, ok, err } from './types.ts';
import { checkWorkspaceWritable } from './workspace.ts';
import { recordFileChange } from '../agent/file-history.ts';

export const writeTool: Tool = {
  name: 'Write',
  description:
    'Write content to a file (creates or overwrites). Parent directories are created as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target file path.' },
      content: { type: 'string', description: 'File content to write.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(input) {
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    const content = typeof input['content'] === 'string' ? input['content'] : '';
    if (!path) return err('path is required');
    const guard = checkWorkspaceWritable(path);
    if (guard) return err(guard);

    try {
      const abs = resolve(path);
      await mkdir(dirname(abs), { recursive: true });
      recordFileChange(abs, 'Write');
      await writeFile(abs, content, 'utf8');
      return ok(`wrote ${content.length} bytes to ${abs}`);
    } catch (e) {
      return err(`Write failed: ${(e as Error).message}`);
    }
  },
};
