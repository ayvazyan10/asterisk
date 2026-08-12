// The one door between a program and the rest of Asterisk.
//
// A program reaches tools through `getTool()` — the same registry lookup the
// agent loop uses — and then calls `execute()` on the tool itself. Nothing is
// re-implemented here, which is the entire point: `Bash` invoked from a program
// runs checkBashSafety → authoriseBashCommand → confineBashCommand exactly as
// it does when the model calls it directly, because it *is* the same call.
// `Write` and `Edit` reach checkWritable the same way. There is no second path
// to a tool's behaviour that could drift from the first.
//
// Going through `getTool()` rather than a private table also means Plan Mode
// keeps working: `listTools()` hides mutating tools while it is on, so a
// program written in Plan Mode cannot Edit its way around the restriction.

import type { Tool } from '../types.ts';

/**
 * Tools a program may not call, and why.
 *
 * The rule is not "dangerous tools" — Bash and Write are deliberately
 * reachable, because their gates are the boundary and a program inherits them
 * intact. The rule is tools whose cost or effect the program's budgets cannot
 * describe:
 *
 *   * `RunCode` re-entering itself would multiply every limit by the nesting
 *     depth, so "50 tool calls" would stop meaning anything.
 *   * `Agent` / `AgentBatch` start a model-driven loop with its own turn budget
 *     and its own bill. A bounded program is the wrong place to hide that.
 *   * `AskUserQuestion` is a modal prompt; a loop around one is fifty modal
 *     prompts, which is a denial of service aimed at a person.
 *   * The Plan Mode toggles change which tools are visible, and a program that
 *     changes its own reachable set halfway through is not analysable.
 */
export const UNREACHABLE_FROM_CODE: ReadonlySet<string> = new Set([
  'RunCode',
  'Agent',
  'AgentBatch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

export type Resolution = { tool: Tool; error: null } | { tool: null; error: string };

/**
 * Looks up a tool for a program, or explains why it cannot have it.
 *
 * The registry is imported dynamically, and that is not stylistic. A static
 * import would close the cycle registry → code/tool → bridge → registry, and
 * registry's `BUILTIN_TOOLS` is built at module scope: any module reaching
 * code/tool.ts first would evaluate that array while `runCodeTool` was still
 * in its temporal dead zone and leave a hole in the built-in list. That is not
 * hypothetical — it broke every tool lookup in this file's own tests, because
 * a test naturally imports the tool under test before the registry.
 */
export async function resolveForCode(name: string): Promise<Resolution> {
  if (UNREACHABLE_FROM_CODE.has(name)) {
    return {
      tool: null,
      error: `tool "${name}" cannot be called from a program — call it directly instead`,
    };
  }
  const { getTool } = await import('../registry.ts');
  const tool = getTool(name);
  if (!tool) {
    return { tool: null, error: `unknown tool "${name}"` };
  }
  return { tool, error: null };
}
