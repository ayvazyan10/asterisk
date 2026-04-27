// Tool registry — central registration of all tools.

import { bashTool } from './bash.ts';
import { editTool } from './edit.ts';
import { globTool } from './glob.ts';
import { grepTool } from './grep.ts';
import { readTool } from './read.ts';
import type { Tool } from './types.ts';
import { writeTool } from './write.ts';

export const ALL_TOOLS: Tool[] = [bashTool, readTool, writeTool, editTool, grepTool, globTool];

export function getTool(name: string): Tool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export function toolDefinitions() {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
