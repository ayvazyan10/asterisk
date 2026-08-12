// Tool registry types — each tool exports an instance of Tool.
// Schemas are JSON-Schema-shaped objects that travel directly to the model.

export interface ToolExecuteOptions {
  /** Cancellation signal threaded down from the agent loop. Long-running
   *  tools (Bash, Grep) honour it; fast tools may ignore it. */
  signal?: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  /** Set when the tool can legitimately spend minutes waiting on a person —
   *  AskUserQuestion, or Bash pausing for approval. The agent loop's default
   *  120s deadline exists to stop runaway work, and a human reading a prompt
   *  is not runaway work; without this flag the loop kills the tool before the
   *  answer can arrive. Interactive tools must enforce their own bound, since
   *  the loop only backstops them. */
  interactive?: boolean;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute(input: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<ToolResult>;
}

export interface ToolAttachment {
  kind: 'image' | 'video' | 'audio' | 'document';
  path: string;
  caption?: string;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  /** Optional files the tool wants delivered to the user out-of-band — e.g.
   *  via Telegram's sendPhoto, WhatsApp's sendMessage(MessageMedia), or the
   *  REPL's inline image rendering. The Attach tool produces these; the
   *  agent loop forwards them to a per-turn collector via onAttachment. */
  attachments?: ToolAttachment[];
}

export function ok(output: string): ToolResult {
  return { output, isError: false };
}

export function err(message: string): ToolResult {
  return { output: message, isError: true };
}
