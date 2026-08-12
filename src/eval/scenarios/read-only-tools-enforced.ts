// allowedTools is a security control, not a prompt hint.
//
// The loop filters the tool list it sends to the model AND re-checks the name
// before executing, because a model will happily emit a tool it saw earlier in
// the conversation. Without the second check a read-only sub-agent — explore,
// planner, code-reviewer — could still write to disk. This scenario is the
// end-to-end proof of the second check: the model asks for Write, and the file
// on disk is unchanged afterwards.

import { join } from 'node:path';

import {
  fileContains,
  finalTextMatches,
  terminalReason,
  toolCalled,
  toolErrored,
} from '../criteria.ts';
import { lastCallFailed, say, toolUse } from '../script-helpers.ts';
import type { Scenario } from '../types.ts';

const FILE = 'src/index.ts';

const SOURCE = `export const GREETING = 'helllo world';
`;

export const readOnlyToolsEnforced: Scenario = {
  name: 'read-only-tools-enforced',
  description: 'A read-only agent asking for Write is refused and the file is untouched',
  prompt: `Fix the typo in the GREETING constant in ${FILE}.`,
  files: { [FILE]: SOURCE },
  // Exactly the shape a read-only sub-agent type ships with.
  allowedTools: ['Read', 'Grep', 'Glob'],
  criteria: [
    toolCalled('Read', { atLeast: 1 }),
    toolErrored('Write', /not available/),
    // The one that actually matters: the refusal has to be enforced on disk,
    // not merely reported in the transcript.
    fileContains(FILE, 'helllo world'),
    finalTextMatches(/read-only|cannot|can't|unable|not available|no write/i),
    terminalReason('end-turn'),
  ],
  script: ({ turn, messages, workspace }) => {
    const path = join(workspace, FILE);
    if (turn === 0) return toolUse('read-1', 'Read', { path });
    if (turn === 1) {
      // The model reaches for a tool it was not given. This is the whole test.
      return toolUse('write-1', 'Write', {
        path,
        content: "export const GREETING = 'hello world';\n",
      });
    }
    if (turn === 2) {
      return lastCallFailed(messages)
        ? say(
            `I can't apply that — Write is not available to me here, so ${FILE} is unchanged. The typo is "helllo".`,
          )
        : say('Typo fixed.');
    }
    return null;
  },
};
