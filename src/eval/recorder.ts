// Turns the agent loop's two tool callbacks back into one record per call.
//
// The loop reports a call starting (`onToolUse(name, input)`) and a call
// finishing (`onToolResult(name, output, isError)`) through separate callbacks
// with no correlation id between them, so the pairing has to be reconstructed
// here. Within a single tool name it is FIFO: the oldest unsettled call of that
// name takes the next result.
//
// Caveat, stated once so criteria authors can judge it: when the model emits
// two calls to the *same* concurrency-safe tool in one turn (two Reads, say),
// the loop runs them under Promise.all and the results can land out of order —
// so input and output may be paired to the wrong sibling. Names, ordering,
// counts and error-ness are all still exact; only the input↔output association
// within a same-name parallel batch is approximate. The shipped criteria are
// built to check one side or the other, never a join across both.

import type { ToolCall } from './types.ts';

export interface CallRecorder {
  onToolUse(name: string, input: Record<string, unknown>): void;
  onToolResult(name: string, output: string, isError: boolean): void;
  /** Calls in the order they started, as a detached copy. */
  calls(): ToolCall[];
}

export function createCallRecorder(): CallRecorder {
  const records: ToolCall[] = [];
  /** Indices into `records` awaiting a result, oldest first, per tool name. */
  const awaiting = new Map<string, number[]>();

  return {
    onToolUse(name, input) {
      const index = records.length;
      records.push({ name, input: { ...input }, output: '', isError: false, settled: false });
      const queue = awaiting.get(name);
      if (queue) queue.push(index);
      else awaiting.set(name, [index]);
    },

    onToolResult(name, output, isError) {
      const index = awaiting.get(name)?.shift();
      const pending = index === undefined ? undefined : records[index];
      if (!pending) {
        // A result with no matching start. The loop does not do this today, but
        // recording it is strictly better than dropping evidence on the floor:
        // a criterion checking for an error would otherwise silently miss it.
        records.push({ name, input: {}, output, isError, settled: true });
        return;
      }
      pending.output = output;
      pending.isError = isError;
      pending.settled = true;
    },

    calls() {
      return records.map((c) => ({ ...c, input: { ...c.input } }));
    },
  };
}
