// Deferred tool schemas — the prompt-size half of tool discovery.
//
// Measured on a real install with three MCP servers connected: 148 registered
// tools whose JSON schemas total ~206KB, ~60k tokens, sent on EVERY request
// before the user has typed anything. Notion alone is 37 tools and 124KB. On a
// local llama.cpp that is minutes of prompt-eval per message, every message.
//
// Nothing is unregistered here. `listTools()`/`getTool()` still return the full
// set, so dispatch, the bash gate, write policy, plan mode, UNREACHABLE_FROM_CODE
// and RunCode's bridge behave exactly as before — this module only decides which
// schemas ride along in the `tools` array of a provider request. A tool left out
// is announced in ToolSearch's description (how many, from which server) and
// ToolSearch hands back its full definition on demand.
//
// The other half of the contract lives in the revealed set below. A provider is
// entitled to reject a `tool_use` naming a tool it was never given, so loading a
// tool is sticky: once ToolSearch returns it — or the model calls it anyway and
// the loop dispatches it — the name joins the session's revealed set and its
// schema is in the `tools` array of every later request in that conversation.
// The model therefore never has to call a tool that is absent from its list.

import { currentSessionId } from '../agent/context.ts';
import { loadConfig } from '../config/load.ts';
import type { Tool } from './types.ts';

export type DeferMode = 'off' | 'mcp' | 'all';

/**
 * Built-ins that stay in the prompt no matter what, under `all`.
 *
 * The rule is "what the model reaches for in most turns", not "what is
 * important": everything else is one ToolSearch away, and a round trip is
 * cheap next to carrying the schema forever.
 *
 * - Bash/Read/Write/Edit/Grep/Glob — the working set of nearly every turn.
 * - ToolSearch — the door to the rest. Deferring it would lock the door.
 * - Task* — the system prompt tells the model to keep a todo list for any
 *   non-trivial work, so this family is per-turn by construction. Kept whole:
 *   splitting Get/Stop off saves 500 bytes and buys a confusing half-family.
 * - Agent, AskUserQuestion — delegation and asking the user are how a turn
 *   ends when it cannot finish alone; both are named in the system prompt.
 * - WebSearch/WebFetch — the research fallback chain the system prompt spells
 *   out step by step.
 * - Attach — the only way to hand a file to the user, and in the Telegram
 *   daemon that is a routine reply, not an edge case.
 * - Enter/ExitPlanMode — ExitPlanMode especially: plan mode filters the tool
 *   list down to read-only tools, and a model that cannot see the exit is
 *   stuck in it.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'ToolSearch',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'Agent',
  'AskUserQuestion',
  'WebSearch',
  'WebFetch',
  'Attach',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/** Groups no bigger than this are pointed at by name; bigger ones by count. */
const MAX_NAMES_LISTED = 30;
/** Hard ceiling on the pointer text. Past it every group degrades to a count. */
const POINTER_BUDGET = 1200;

/** MCP tools are namespaced `<server>__<tool>`; built-ins have no separator. */
const BUILTIN_GROUP = 'built-in';

export function deferMode(): DeferMode {
  return loadConfig().config.tools.deferSchemas;
}

// Keyed by session id for the same reason plan mode and tasks are: the daemon
// runs one process for every Telegram chat, and what one chat loaded is not
// what another chat is allowed to see in its prompt.
const revealedBySession = new Map<string, Set<string>>();

/** Marks a tool as loaded for this session, so later requests carry its schema. */
export function revealTool(name: string): void {
  const sid = currentSessionId();
  const set = revealedBySession.get(sid) ?? new Set<string>();
  set.add(name);
  revealedBySession.set(sid, set);
}

export function revealedToolNames(): ReadonlySet<string> {
  return revealedBySession.get(currentSessionId()) ?? new Set<string>();
}

/** Drops the session's loaded set — used by /clear and by tests. */
export function clearRevealedTools(): void {
  revealedBySession.delete(currentSessionId());
}

export interface PromptPartition {
  /** Tools whose full schema goes into the request. */
  visible: Tool[];
  /** Tools the model has to load through ToolSearch first. */
  deferred: Tool[];
}

/**
 * Splits the registered tools into what the request carries and what it only
 * points at. `mcpNames` is the set contributed by MCP servers — origin, not a
 * name pattern, so a built-in that happens to contain `__` is never mistaken
 * for a remote one.
 */
export function partitionForPrompt(
  all: readonly Tool[],
  mcpNames: ReadonlySet<string>,
  mode: DeferMode,
): PromptPartition {
  if (mode === 'off') return { visible: [...all], deferred: [] };
  const revealed = revealedToolNames();
  const visible: Tool[] = [];
  const deferred: Tool[] = [];
  for (const tool of all) {
    if (revealed.has(tool.name) || keepInPrompt(tool.name, mcpNames, mode)) visible.push(tool);
    else deferred.push(tool);
  }
  return { visible, deferred };
}

function keepInPrompt(name: string, mcpNames: ReadonlySet<string>, mode: DeferMode): boolean {
  if (mcpNames.has(name)) return false;
  return mode === 'mcp' ? true : CORE_TOOL_NAMES.has(name);
}

function groupOf(name: string): string {
  const sep = name.indexOf('__');
  return sep > 0 ? name.slice(0, sep) : BUILTIN_GROUP;
}

/** `[[server, names], …]` in first-seen order, so the text is stable. */
function groupNames(deferred: readonly Tool[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const tool of deferred) {
    const key = groupOf(tool.name);
    const bucket = groups.get(key);
    if (bucket) bucket.push(tool.name);
    else groups.set(key, [tool.name]);
  }
  return [...groups.entries()];
}

/**
 * The compact stand-in for the schemas left out, appended to ToolSearch's
 * description — the one tool guaranteed to be in the request.
 *
 * A small group is listed by name, because names are what a keyword search
 * needs and the 27 built-ins `all` defers cost ~460 bytes to spell out. A
 * 44-tool GitHub server is a count: its names cost more than the pointer is
 * worth and "github" is already a good enough query. The budget is spent
 * greedily in list order rather than all-or-nothing, so one oversized server
 * cannot demote the groups in front of it — and the built-ins are in front,
 * because BUILTIN_TOOLS precedes the MCP tools in the registry.
 */
export function deferredPointer(deferred: readonly Tool[]): string {
  let spent = 0;
  const parts = groupNames(deferred).map(([group, names]) => {
    const detailed = `${group} (${names.length}): ${names.join(', ')}`;
    const affordable =
      names.length <= MAX_NAMES_LISTED && spent + detailed.length <= POINTER_BUDGET;
    const part = affordable ? detailed : `${group}: ${names.length} tools`;
    spent += part.length;
    return part;
  });
  return `NOT every tool is listed in this request. ${deferred.length} more are available on demand — ${parts.join('; ')}. Call ToolSearch to load the ones you need before using them.`;
}
