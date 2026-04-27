// Tool registry types — each tool exports an instance of Tool.
// Schemas are JSON-Schema-shaped objects that travel directly to the model.

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

export function ok(output: string): ToolResult {
  return { output, isError: false };
}

export function err(message: string): ToolResult {
  return { output: message, isError: true };
}
