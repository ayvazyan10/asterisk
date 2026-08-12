// Tool registry — central registration. The built-in set is static; MCP tools
// can be added at runtime via setExtraTools so the agent loop sees them
// alongside the built-ins without a special code path.

import { MCP_RESOURCE_TOOLS } from '../mcp/resources.ts';
import { agentBatchTool } from './agent-batch.ts';
import { ASK_TOOLS } from './ask.ts';
import { attachTool } from './attach.ts';
import { bashTool } from './bash.ts';
import { BROWSER_TOOLS } from './browser/tools.ts';
import { codeIntelTool } from './code-intel.ts';
import { diffReviewTool } from './diff-review.ts';
import { editTool } from './edit.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { MEMORY_TOOLS } from './memory.ts';
import { MONITOR_TOOLS } from './monitor.ts';
import { NOTIFY_TOOLS } from './notify.ts';
import { PLAN_MODE_TOOLS, isPlanMode, isReadOnlyToolName } from './planmode.ts';
import { readTool } from './read.ts';
import { SCHEDULE_TOOLS } from './schedule.ts';
import { subAgentTool } from './subagent.ts';
import { TASK_TOOLS } from './tasks.ts';
import { toolSearchTool } from './tool-search.ts';
import type { Tool } from './types.ts';
import { webFetchTool } from './webfetch.ts';
import { webSearchTool } from './websearch.ts';
import { WORKTREE_TOOLS } from './worktree.ts';
import { writeTool } from './write.ts';

export const BUILTIN_TOOLS: Tool[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  ...BROWSER_TOOLS,
  webFetchTool,
  webSearchTool,
  ...TASK_TOOLS,
  ...MEMORY_TOOLS,
  subAgentTool,
  agentBatchTool,
  ...PLAN_MODE_TOOLS,
  ...WORKTREE_TOOLS,
  ...NOTIFY_TOOLS,
  ...MONITOR_TOOLS,
  ...ASK_TOOLS,
  ...SCHEDULE_TOOLS,
  attachTool,
  toolSearchTool,
  codeIntelTool,
  diffReviewTool,
  ...MCP_RESOURCE_TOOLS,
];

let extraTools: Tool[] = [];

export function setExtraTools(tools: Tool[]): void {
  extraTools = tools;
}

export function listTools(): Tool[] {
  const all = [...BUILTIN_TOOLS, ...extraTools];
  // Plan Mode hides write/mutating tools so the agent can only research.
  if (isPlanMode()) return all.filter((t) => isReadOnlyToolName(t.name));
  return all;
}

export function getTool(name: string): Tool | undefined {
  return listTools().find((t) => t.name === name);
}

export function toolDefinitions() {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
