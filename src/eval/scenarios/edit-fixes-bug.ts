// The simplest thing the agent has to be able to do: read a file, find the
// wrong line, change it, and say so. If this scenario fails, nothing further
// down the list is worth reading.

import { join } from 'node:path';

import {
  fileContains,
  fileLacks,
  finalTextMatches,
  terminalReason,
  toolCalled,
  toolSucceeded,
} from '../criteria.ts';
import { say, toolUse } from '../script-helpers.ts';
import type { Scenario } from '../types.ts';

const FILE = 'src/total.ts';

const BUGGY = `export function total(items: number[]): number {
  let sum = 0;
  for (const n of items) sum -= n;
  return sum;
}
`;

export const editFixesBug: Scenario = {
  name: 'edit-fixes-bug',
  description: 'Read a file, fix a wrong operator with Edit, report the change',
  prompt: `total() in ${FILE} is supposed to add the numbers together, but it subtracts them. Fix it.`,
  files: { [FILE]: BUGGY },
  criteria: [
    fileContains(FILE, 'sum += n'),
    fileLacks(FILE, 'sum -= n'),
    // Exactly one Edit: a fix that took three tries is a different behaviour
    // from a fix that took one, and the harness should be able to tell.
    toolCalled('Edit', { times: 1 }),
    toolSucceeded('Edit'),
    // Everything else can be right while the loop ends on max-turns, which
    // would be an agent that never told the user it was finished.
    terminalReason('end-turn'),
    finalTextMatches(/total|sum|add|fix/i),
  ],
  script: ({ turn, workspace }) => {
    const path = join(workspace, FILE);
    if (turn === 0) return toolUse('read-1', 'Read', { path });
    if (turn === 1) {
      return toolUse('edit-1', 'Edit', { path, oldString: 'sum -= n', newString: 'sum += n' });
    }
    if (turn === 2)
      return say(`Fixed the operator in ${FILE} — total() now adds instead of subtracting.`);
    return null;
  },
};
