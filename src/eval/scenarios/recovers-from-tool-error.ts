// The failure mode this catches: an agent that treats a tool error as the end
// of the road, or that retries the identical call forever. The right behaviour
// is to read the error, go find out what the file actually says, and try again
// with the corrected input.
//
// The script here branches on the observed error rather than replaying a fixed
// three-step sequence, so a harness that stopped surfacing tool errors to the
// model would take this scenario down instead of quietly still passing it.

import { join } from 'node:path';

import {
  fileContains,
  fileLacks,
  terminalReason,
  toolCalled,
  toolErrored,
  toolSequence,
} from '../criteria.ts';
import { lastCallFailed, say, toolUse } from '../script-helpers.ts';
import type { Scenario } from '../types.ts';

const CONFIG = 'config.ini';

// Spaces around the `=` are the trap: the obvious first guess at an oldString
// is `timeout=30`, which is not in the file.
const ORIGINAL = `[server]
host = 127.0.0.1
timeout = 30
retries = 3
`;

export const recoversFromToolError: Scenario = {
  name: 'recovers-from-tool-error',
  description: 'A failed Edit is diagnosed with Read and retried correctly',
  prompt: `Bump the request timeout in ${CONFIG} from 30 to 60.`,
  files: { [CONFIG]: ORIGINAL },
  criteria: [
    toolErrored('Edit', /not found/),
    toolCalled('Edit', { times: 2 }),
    // Order matters: Edit → Read → Edit is recovery. Edit → Edit → Read is
    // guessing twice and then looking, which happens to land the same result.
    toolSequence(['Edit', 'Read', 'Edit']),
    fileContains(CONFIG, 'timeout = 60'),
    fileLacks(CONFIG, 'timeout = 30'),
    // The surrounding lines prove the fix was surgical rather than a rewrite
    // of the whole file from the model's memory of it.
    fileContains(CONFIG, 'host = 127.0.0.1'),
    fileContains(CONFIG, 'retries = 3'),
    terminalReason('end-turn'),
  ],
  script: ({ turn, messages, workspace }) => {
    const path = join(workspace, CONFIG);
    if (turn === 0) {
      // The plausible-but-wrong first attempt.
      return toolUse('edit-1', 'Edit', {
        path,
        oldString: 'timeout=30',
        newString: 'timeout=60',
      });
    }
    if (turn === 1) {
      if (!lastCallFailed(messages)) {
        // Edit reported success on a string the file does not contain. Say so
        // and let the file-content criteria record the damage.
        return say('The first edit reported success.');
      }
      return toolUse('read-1', 'Read', { path });
    }
    if (turn === 2) {
      return toolUse('edit-2', 'Edit', {
        path,
        oldString: 'timeout = 30',
        newString: 'timeout = 60',
      });
    }
    if (turn === 3) {
      return say(`My first edit missed the spacing; re-read ${CONFIG} and set timeout = 60.`);
    }
    return null;
  },
};
