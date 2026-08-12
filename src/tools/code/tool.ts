// RunCode — express a batch of work as one short program instead of a chain of
// tool calls.
//
// What this does that Bash cannot
// -------------------------------
// Bash can already loop: `grep -rl old . | xargs sed -i s/old/new/g` renames a
// symbol across forty files in a single call. What it cannot do is call
// Asterisk's own tools. A program can, so it gets:
//
//   * `Edit` semantics — a unique-match requirement that catches an ambiguous
//     rename instead of silently rewriting every near-miss, and a snapshot into
//     ~/.asterisk/file-history for every file touched. `sed -i` has neither.
//   * tools with no shell equivalent at all: Grep's structured output, WebFetch,
//     Remember/Recall, TaskCreate/TaskUpdate, the browser tools. "For each open
//     task, fetch its URL and remember the title" is not a shell command.
//   * per-call results as values — `r.ok` and `r.output` — so a failure at file
//     17 of 40 can be collected and reported rather than aborting the pipeline
//     or vanishing into an exit code.
//   * no shell portability tax: no GNU-vs-BSD `sed -i` argument, no quoting a
//     replacement string through two levels of shell.
//
// If a task is genuinely a shell pipeline, use Bash. This exists for the case
// where the loop body is an Asterisk tool.
//
// The boundary
// ------------
// Programs are not JavaScript and are not run by `node:vm` — see the header of
// interpreter.ts for the measured reason why a vm would have handed the model
// `process.env` and `fs.writeFileSync`. Tools are reached through the registry,
// so every gate fires per call, unchanged.

import { type Tool, type ToolAttachment, err, ok } from '../types.ts';
import { resolveForCode } from './bridge.ts';
import { type RunOutcome, type ToolCallRecord, runProgram } from './interpreter.ts';
import { display } from './values.ts';

const DEFAULT_TIMEOUT_S = 30;
const MIN_TIMEOUT_S = 1;
/** Generous because a program may call Bash, and Bash may sit on a permission
 *  prompt for up to 90 seconds before it even starts running. */
const MAX_TIMEOUT_S = 300;

const DEFAULT_MAX_TOOL_CALLS = 50;
const MAX_MAX_TOOL_CALLS = 200;

/** Bounds a loop that makes no tool calls at all — `while (true) {}` ends here,
 *  in well under a second, rather than waiting out the whole wall clock. */
const MAX_STEPS = 2_000_000;
const MAX_DEPTH = 64;
const MAX_LOG_CHARS = 20_000;
const MAX_STRING_LENGTH = 2_000_000;
const MAX_ARRAY_LENGTH = 100_000;
const MAX_TOOL_OUTPUT_CHARS = 200_000;
/** Forwarded out-of-band files (screenshots, mostly). Capped because a loop
 *  around BrowserScreenshot would otherwise post fifty images to a chat. */
const MAX_ATTACHMENTS = 4;

const DESCRIPTION = `Run a short program that calls Asterisk's tools in a loop, in one turn instead of N.

Use it when the same tool call repeats over a list — rename a symbol across 40 files, read every match from a Grep and edit the ones that qualify, create a task per TODO. For a one-off call, just call the tool. For a genuine shell pipeline, use Bash.

  const found = tool('Grep', { pattern: 'oldName', path: 'src' });
  let done = 0;
  for (const line of found.output.split('\\n')) {
    const path = line.split(':')[0];
    if (!path) continue;
    const r = tool('Edit', { path, oldString: 'oldName', newString: 'newName', replaceAll: true });
    if (r.ok) done += 1; else log(\`failed \${path}: \${r.output}\`);
  }
  return done;

tool(name, input) calls any tool you can call yourself and returns { ok, output, tool } — it never throws, so check r.ok. Every tool keeps its own rules: Bash still asks the user to approve a command, Write/Edit still refuse paths outside the writable set. log(...) records a line for you to read afterwards; return sends back a value.

The language is a subset of JavaScript: const/let, if/else, for-of, C-style for, while, break/continue, return, arrow functions, template literals, ===/!==, &&/||/??, +-*/%. Strings and arrays have their usual methods (split, slice, includes, map, filter, join, push, sort, …), plus JSON, Object.keys/values/entries, Math, String/Number/Boolean. There is no function/class/new/import/require/eval/try-catch/regex — a program that needs those is a program that should be Bash or separate tool calls.

Bounded: ${DEFAULT_TIMEOUT_S}s wall clock and ${DEFAULT_MAX_TOOL_CALLS} tool calls by default (raise via timeoutSeconds / maxToolCalls), and an infinite loop ends the call, not the session. Errors come back with a line number.`;

export const runCodeTool: Tool = {
  name: 'RunCode',
  // A program may call Bash, whose permission gate can legitimately spend up to
  // 90s waiting on a person — longer than the agent loop's 120s tool deadline
  // once a few calls stack up. The loop only backstops interactive tools, so
  // this one enforces its own bound: see the wall clock below.
  interactive: true,
  description: DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      program: {
        type: 'string',
        description: 'The program to run.',
      },
      timeoutSeconds: {
        type: 'number',
        description: `Wall-clock budget (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}). Raise it if the program calls Bash and the user has to approve commands.`,
      },
      maxToolCalls: {
        type: 'number',
        description: `Cap on tool calls the program may make (default ${DEFAULT_MAX_TOOL_CALLS}, max ${MAX_MAX_TOOL_CALLS}).`,
      },
    },
    required: ['program'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const program = typeof input['program'] === 'string' ? input['program'] : '';
    if (!program.trim()) return err('program is required');

    const timeoutSeconds = clamp(
      typeof input['timeoutSeconds'] === 'number' ? input['timeoutSeconds'] : DEFAULT_TIMEOUT_S,
      MIN_TIMEOUT_S,
      MAX_TIMEOUT_S,
    );
    const maxToolCalls = clamp(
      typeof input['maxToolCalls'] === 'number' ? input['maxToolCalls'] : DEFAULT_MAX_TOOL_CALLS,
      0,
      MAX_MAX_TOOL_CALLS,
    );

    // Nothing should start for a turn that has already been abandoned.
    if (opts?.signal?.aborted) return err('program cancelled before it started');

    const attachments: ToolAttachment[] = [];
    const started = Date.now();

    const outcome = await runProgram(program, {
      limits: {
        maxSteps: MAX_STEPS,
        maxToolCalls,
        maxDepth: MAX_DEPTH,
        deadline: started + timeoutSeconds * 1000,
        maxLogChars: MAX_LOG_CHARS,
        maxStringLength: MAX_STRING_LENGTH,
        maxArrayLength: MAX_ARRAY_LENGTH,
        maxToolOutputChars: MAX_TOOL_OUTPUT_CHARS,
      },
      ...(opts?.signal ? { signal: opts.signal } : {}),
      bridge: async (name, toolInput) => {
        const resolved = await resolveForCode(name);
        if (!resolved.tool) return { ok: false, output: resolved.error };
        try {
          // The same call the agent loop makes, including the signal — so ESC
          // reaches a Bash running inside a program, not just the program.
          const result = await resolved.tool.execute(
            toolInput,
            opts?.signal ? { signal: opts.signal } : {},
          );
          for (const a of result.attachments ?? []) {
            if (attachments.length < MAX_ATTACHMENTS) attachments.push(a);
          }
          return { ok: !result.isError, output: result.output };
        } catch (e) {
          // A tool that throws instead of returning an error result must not
          // take the whole program down with it.
          return { ok: false, output: `${name} threw: ${(e as Error).message}` };
        }
      },
    });

    const elapsed = Date.now() - started;
    const text = render(outcome, elapsed);
    const result = outcome.ok ? ok(text) : err(text);
    return attachments.length > 0 ? { ...result, attachments } : result;
  },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function render(outcome: RunOutcome, elapsedMs: number): string {
  const failed = outcome.calls.filter((c) => !c.ok);
  const sections: string[] = [];

  if (outcome.ok) {
    sections.push(`✓ program finished · ${callSummary(outcome.calls)} · ${elapsedMs}ms`);
    if (outcome.value !== null) sections.push(`return: ${display(outcome.value)}`);
  } else {
    const e = outcome.error;
    const where = e && e.line !== null ? ` at line ${e.line}, col ${e.col}` : '';
    const label = e?.kind === 'syntax' ? 'will not parse' : 'failed';
    sections.push(`✗ program ${label}${where}: ${e?.message ?? 'unknown error'}`);
    if (outcome.calls.length > 0) {
      sections.push(`${callSummary(outcome.calls)} before it stopped — that work is done.`);
    }
    if (e?.limit === 'steps' || e?.limit === 'time') {
      sections.push('Narrow the work, or raise timeoutSeconds if it was genuinely that big.');
    }
    if (e?.limit === 'tool-calls') {
      sections.push('Raise maxToolCalls, or split the work across two programs.');
    }
  }

  if (failed.length > 0) {
    const shown = failed.slice(0, 20);
    const lines = shown.map(
      (c) => `  #${c.index} ${c.name} (line ${c.line}): ${oneLine(c.detail)}`,
    );
    if (failed.length > shown.length) lines.push(`  … and ${failed.length - shown.length} more`);
    sections.push(`failed calls:\n${lines.join('\n')}`);
  }

  if (outcome.log.length > 0) {
    sections.push(`log:\n${outcome.log.map((l) => `  ${l}`).join('\n')}`);
  }

  return sections.join('\n');
}

function callSummary(calls: readonly ToolCallRecord[]): string {
  if (calls.length === 0) return 'no tool calls';
  const failed = calls.filter((c) => !c.ok).length;
  const noun = calls.length === 1 ? 'tool call' : 'tool calls';
  return failed === 0
    ? `${calls.length} ${noun}, all ok`
    : `${calls.length} ${noun}, ${failed} failed`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim() || '(no message)';
}
