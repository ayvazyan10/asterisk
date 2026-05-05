// Edit tool — exact string replacement in a file. Requires uniqueness unless
// replaceAll is set.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Tool, ok, err } from './types.ts';
import { checkWorkspaceWritable } from './workspace.ts';
import { recordFileChange } from '../agent/file-history.ts';

export const editTool: Tool = {
  name: 'Edit',
  description:
    'Replace an exact string in a file. Set replaceAll:true to swap every occurrence in one call (cheaper than per-match). Multiple Edits in the same turn for distinct strings.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
      replaceAll: { type: 'boolean' },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  async execute(input) {
    const path = typeof input['path'] === 'string' ? input['path'] : '';
    const oldString = typeof input['oldString'] === 'string' ? input['oldString'] : '';
    const newString = typeof input['newString'] === 'string' ? input['newString'] : '';
    const replaceAll = input['replaceAll'] === true;
    if (!path) return err('path is required');
    if (!oldString) return err('oldString is required (and must be non-empty)');
    const guard = checkWorkspaceWritable(path);
    if (guard) return err(guard);

    try {
      const abs = resolve(path);
      const original = await readFile(abs, 'utf8');
      if (replaceAll) {
        const next = original.split(oldString).join(newString);
        if (next === original) return err('oldString not found in file');
        recordFileChange(abs, 'Edit');
        await writeFile(abs, next, 'utf8');
        const count = original.split(oldString).length - 1;
        return ok(`replaced ${count} occurrence(s) in ${abs}`);
      }
      const idx = original.indexOf(oldString);
      if (idx === -1) return err('oldString not found in file');
      const second = original.indexOf(oldString, idx + oldString.length);
      if (second !== -1) {
        return err('oldString is not unique; pass replaceAll=true to replace every occurrence');
      }
      const next = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
      recordFileChange(abs, 'Edit');
      await writeFile(abs, next, 'utf8');
      return ok(`replaced 1 occurrence in ${abs}`);
    } catch (e) {
      return err(`Edit failed: ${(e as Error).message}`);
    }
  },
};
