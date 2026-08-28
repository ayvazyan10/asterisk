// Plan Mode — when active for the current session, write/mutate tools are
// hidden from the agent so it can only research. State is per-session: each
// Telegram chat and the REPL toggles independently.

import { currentSessionId } from '../agent/context.ts';
import { type Tool, ok } from './types.ts';

const planModeBySession = new Set<string>();

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
  // Recall reads; Remember writes and stays hidden with the rest of them.
  'Recall',
  'EnterPlanMode',
  'ExitPlanMode',
  // Reads tool metadata and returns schemas; it runs nothing. Hiding it here
  // would strand a plan-mode turn that needs an MCP tool, because with
  // deferred schemas ToolSearch is the only way to load one.
  'ToolSearch',
  'Agent',
  'Attach',
  // Reading an audio file is research like any other read. The command
  // backend does run a process, but one the user configured for this purpose.
  'Transcribe',
]);

export function isPlanMode(): boolean {
  return planModeBySession.has(currentSessionId());
}

export function setPlanMode(v: boolean): void {
  const sid = currentSessionId();
  if (v) planModeBySession.add(sid);
  else planModeBySession.delete(sid);
}

export function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_NAMES.has(name);
}

export const enterPlanModeTool: Tool = {
  name: 'EnterPlanMode',
  description:
    'Enter read-only Plan Mode. While active, only research tools are available (Read, Grep, Glob, browser navigation/snapshots, WebFetch, WebSearch, TaskList/Get, sub-agents). Use to investigate before proposing changes; call ExitPlanMode when ready to act.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: "Optional note describing why you're entering plan mode.",
      },
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
