// Plan Mode — when active, write/mutate tools are hidden from the agent so
// it can only research. EnterPlanMode flips the flag on; ExitPlanMode flips
// it off. listTools() in the registry consults this flag and filters.

let planModeActive = false;

const READ_ONLY_NAMES = new Set([
  'Read',
  'Grep',
  'Glob',
  'BrowserNavigate',
  'BrowserSnapshot',
  'BrowserScreenshot',
  'BrowserWait',
  'BrowserClose',
  'WebFetch',
  'WebSearch',
  'TaskList',
  'TaskGet',
  'EnterPlanMode',
  'ExitPlanMode',
  'Agent',
]);

export function isPlanMode(): boolean {
  return planModeActive;
}

export function setPlanMode(v: boolean): void {
  planModeActive = v;
}

export function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_NAMES.has(name);
}

import { type Tool, ok } from './types.ts';

export const enterPlanModeTool: Tool = {
  name: 'EnterPlanMode',
  description:
    'Enter read-only Plan Mode. While active, only research tools are available (Read, Grep, Glob, browser navigation/snapshots, WebFetch, WebSearch, TaskList/Get, sub-agents). Use to investigate before proposing changes; call ExitPlanMode when ready to act.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Optional note describing why you\'re entering plan mode.' },
    },
    additionalProperties: false,
  },
  async execute(input) {
    setPlanMode(true);
    const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : '';
    return ok(`✓ Plan Mode ON · write tools disabled${reason ? `\nreason: ${reason}` : ''}`);
  },
};

export const exitPlanModeTool: Tool = {
  name: 'ExitPlanMode',
  description: 'Leave Plan Mode and re-enable mutating tools (Bash, Write, Edit, …).',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    setPlanMode(false);
    return ok('✓ Plan Mode OFF · all tools re-enabled');
  },
};

export const PLAN_MODE_TOOLS: Tool[] = [enterPlanModeTool, exitPlanModeTool];
