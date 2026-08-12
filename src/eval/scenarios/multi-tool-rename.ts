// A rename that cannot be done with one tool: find the occurrences, read the
// files, change them, check the change landed. It also exercises two paths the
// single-Edit scenario cannot reach — several concurrency-safe tools batched
// into one model turn, and a scoped change that has to leave a matching file
// outside the target directory alone.

import { join } from 'node:path';

import {
  fileContains,
  fileLacks,
  finalTextMatches,
  toolCalled,
  toolSequence,
  toolSucceeded,
} from '../criteria.ts';
import { say, toolBatch, toolUse } from '../script-helpers.ts';
import type { Scenario } from '../types.ts';

const UTIL = 'src/util.ts';
const APP = 'src/app.ts';
const NOTES = 'docs/notes.md';

const FILES = {
  [UTIL]: `export function legacyName(value: string): string {
  return value.trim();
}
`,
  [APP]: `import { legacyName } from './util.ts';

export function run(raw: string): string {
  return legacyName(raw);
}
`,
  // Same symbol, outside the directory the prompt scopes the change to. A
  // rename that touches this one has done too much, and that is as much of a
  // defect as one that touches too little.
  [NOTES]: `# Notes

The helper is currently called legacyName; we may rename it one day.
`,
};

export const multiToolRename: Scenario = {
  name: 'multi-tool-rename',
  description: 'Grep → Read → Edit → verify: rename a symbol across src/ only',
  prompt:
    'Rename the exported helper `legacyName` to `currentName` everywhere under {{workspace}}/src, including the import site. Leave everything outside src/ alone.',
  files: FILES,
  criteria: [
    toolSequence(['Grep', 'Read', 'Edit', 'Grep']),
    fileContains(UTIL, 'export function currentName'),
    fileLacks(UTIL, 'legacyName'),
    fileContains(APP, 'import { currentName }'),
    fileContains(APP, 'return currentName(raw)'),
    fileLacks(APP, 'legacyName'),
    fileContains(NOTES, 'legacyName'),
    toolCalled('Edit', { times: 2 }),
    toolSucceeded('Edit'),
    finalTextMatches(/currentName/),
  ],
  script: ({ turn, workspace }) => {
    const util = join(workspace, UTIL);
    const app = join(workspace, APP);
    if (turn === 0) {
      return toolUse('grep-1', 'Grep', { pattern: 'legacyName', path: join(workspace, 'src') });
    }
    if (turn === 1) {
      return toolBatch([
        { id: 'read-1', name: 'Read', input: { path: util } },
        { id: 'read-2', name: 'Read', input: { path: app } },
      ]);
    }
    if (turn === 2) {
      const swap = { oldString: 'legacyName', newString: 'currentName', replaceAll: true };
      return toolBatch([
        { id: 'edit-1', name: 'Edit', input: { path: util, ...swap } },
        { id: 'edit-2', name: 'Edit', input: { path: app, ...swap } },
      ]);
    }
    if (turn === 3) {
      return toolUse('grep-2', 'Grep', { pattern: 'legacyName', path: join(workspace, 'src') });
    }
    if (turn === 4) {
      return say(
        'Renamed legacyName to currentName in src/util.ts and src/app.ts; docs/notes.md was left as-is.',
      );
    }
    return null;
  },
};
