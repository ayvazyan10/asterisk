// Tool registry — central registration. The built-in set is static; MCP tools
// can be added at runtime via setExtraTools so the agent loop sees them
// alongside the built-ins without a special code path.

import { bashTool } from './bash.ts';
import { BROWSER_TOOLS } from './browser/tools.ts';
import { editTool } from './edit.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { readTool } from './read.ts';
import { subAgentTool } from './subagent.ts';
import { TASK_TOOLS } from './tasks.ts';
import type { Tool } from './types.ts';
import { webFetchTool } from './webfetch.ts';
import { webSearchTool } from './websearch.ts';
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
  subAgentTool,
];

let extraTools: Tool[] = [];

export function setExtraTools(tools: Tool[]): void {
  extraTools = tools;
}

export function listTools(): Tool[] {
  return [...BUILTIN_TOOLS, ...extraTools];
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
