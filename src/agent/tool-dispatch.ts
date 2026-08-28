// Dispatch plumbing for the agent loop: which tool calls may run together, how
// often the same call may repeat, and the hard deadline every call runs under.
//
// Extracted from loop.ts, which had grown past the size this project holds
// itself to. Nothing here knows about history, providers or hooks — it is the
// mechanical half of running a batch of tool calls.

import { isConcurrencySafe } from '../tools/concurrency.ts';
import type { ToolUseBlock } from '../types/messages.ts';

/** Bumps and returns the count of dispatches of this exact call this turn. */
export function countCall(
  counts: Map<string, number>,
  name: string,
  input: Record<string, unknown>,
): number {
  let signature: string;
  try {
    signature = `${name}:${JSON.stringify(input)}`;
  } catch {
    // Unserialisable input cannot be compared, so it is never "identical".
    return 1;
  }
  const next = (counts.get(signature) ?? 0) + 1;
  counts.set(signature, next);
  return next;
}

// Partition tool_use blocks into sequential/parallel batches.
// Consecutive concurrency-safe tools form a parallel batch; any
// non-safe tool breaks the sequence and runs alone.
export interface ToolBatch {
  uses: ToolUseBlock[];
  parallel: boolean;
}

export function partitionTools(uses: ToolUseBlock[]): ToolBatch[] {
  const batches: ToolBatch[] = [];
  let currentParallel: ToolUseBlock[] = [];

  for (const use of uses) {
    if (isConcurrencySafe(use.name)) {
      currentParallel.push(use);
    } else {
      if (currentParallel.length > 0) {
        batches.push({ uses: currentParallel, parallel: true });
        currentParallel = [];
      }
      batches.push({ uses: [use], parallel: false });
    }
  }
  if (currentParallel.length > 0) {
    batches.push({ uses: currentParallel, parallel: true });
  }
  return batches;
}

export interface ToolExecResult {
  output: string;
  isError: boolean;
  attachments?: Array<{ kind: string; path: string; caption?: string }>;
}

export async function runToolWithTimeout(
  tool: {
    execute: (
      input: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<ToolExecResult>;
  },
  input: Record<string, unknown>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<ToolExecResult> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  // Hard deadline via Promise.race — guarantees we return within timeoutMs
  // even if the tool ignores the AbortSignal (e.g. execa + Bun edge cases
  // where cancelSignal doesn't kill the child process tree).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ToolExecResult>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort(new Error(`tool timeout after ${Math.round(timeoutMs / 1000)}s`));
      resolve({
        output: `tool timed out after ${Math.round(timeoutMs / 1000)}s`,
        isError: true,
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      tool.execute(input, { signal: ctrl.signal }).catch((e) => ({
        output: `tool execution error: ${(e as Error).message}`,
        isError: true,
      })),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onParentAbort);
  }
}
