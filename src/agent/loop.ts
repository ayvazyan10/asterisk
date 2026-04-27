// Agent loop — drives a Provider through tool-use turns until end_turn.
// Reference: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use

import type {
  ContentBlock,
  Message,
  Provider,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../types/messages.ts';
import { getTool, toolDefinitions } from '../tools/registry.ts';

const SYSTEM_PROMPT = `You are Asterisk, a local-first AI agent CLI running on the user's machine.
You can use tools (Bash, Read, Write, Edit, Grep, Glob) to inspect and modify the filesystem.
Be concise. Prefer doing work directly with tools over describing what you would do.
When a task is complete, respond with a short summary.`;

export interface AgentState {
  history: Message[];
}

export function createAgentState(): AgentState {
  return { history: [] };
}

export interface RunOptions {
  maxTurns?: number;
  onAssistantText?: (text: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, output: string, isError: boolean) => void;
}

export async function runAgentTurn(
  provider: Provider,
  state: AgentState,
  userInput: string,
  opts: RunOptions = {},
): Promise<string> {
  const maxTurns = opts.maxTurns ?? 10;

  state.history.push({
    role: 'user',
    content: [{ type: 'text', text: userInput }],
  });

  let finalText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await provider.send({
      system: SYSTEM_PROMPT,
      messages: state.history,
      tools: toolDefinitions(),
    });

    state.history.push({ role: 'assistant', content: response.content });

    const textBlocks = response.content.filter((b): b is TextBlock => b.type === 'text');
    for (const t of textBlocks) {
      if (t.text) opts.onAssistantText?.(t.text);
    }

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

    if (toolUses.length === 0 || response.stopReason === 'end_turn') {
      finalText = textBlocks.map((b) => b.text).join('\n');
      break;
    }

    const toolResults: ContentBlock[] = [];
    for (const use of toolUses) {
      opts.onToolUse?.(use.name, use.input);
      const tool = getTool(use.name);
      let output: string;
      let isError: boolean;
      if (!tool) {
        output = `tool not found: ${use.name}`;
        isError = true;
      } else {
        const result = await tool.execute(use.input);
        output = result.output;
        isError = result.isError;
      }
      opts.onToolResult?.(use.name, output, isError);
      const tr: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: use.id,
        content: output,
        is_error: isError,
      };
      toolResults.push(tr);
    }

    state.history.push({ role: 'user', content: toolResults });
  }

  return finalText;
}
