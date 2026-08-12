// The shipped scenario set. Each one exists to cover a path the others cannot
// reach — a single edit, a multi-tool sequence with batching and scoping, a
// refused write, a recovered tool error, and an enforced tool restriction.
//
// Adding one: write the module, export the Scenario, add it here. Keep the
// criteria objective; if a scenario needs a model to decide whether it passed,
// it is measuring taste rather than behaviour.

import type { Scenario } from '../types.ts';
import { editFixesBug } from './edit-fixes-bug.ts';
import { multiToolRename } from './multi-tool-rename.ts';
import { readOnlyToolsEnforced } from './read-only-tools-enforced.ts';
import { recoversFromToolError } from './recovers-from-tool-error.ts';
import { refusesEscapingWorkspace } from './refuses-escaping-workspace.ts';

export const SCENARIOS: readonly Scenario[] = [
  editFixesBug,
  multiToolRename,
  refusesEscapingWorkspace,
  recoversFromToolError,
  readOnlyToolsEnforced,
];
