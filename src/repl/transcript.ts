// Transcript entries and the pure decisions about them: how a tool call and
import { t } from '../i18n/index.ts';
// its result are summarised into a one-line entry, when the full payload is
// kept behind a collapse hint, what Ctrl+O appends, and which system lines
// look like "Label   value" pairs.
//
// Extracted from App.tsx because this is policy, not layout — it decides what
// the user is shown and what is hidden, and every one of those rules is worth
// pinning down without mounting a terminal.

export type EntryKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'tool-result'
  | 'system'
  | 'progress'
  | 'error';

export interface Entry {
  id: string;
  kind: EntryKind;
  /** Short, always-shown form (1–2 lines). */
  text: string;
  /** Full payload, revealed when expanded. Absent → text is the whole thing. */
  fullText?: string;
}

/** Longest one-line tool-call summary before the rest moves behind Ctrl+O. */
const TOOL_CALL_LINE_MAX = 80;
/** Same, for the status line in the working indicator — narrower. */
const TOOL_CALL_STATUS_MAX = 60;
/** Longest tool result kept inline. */
const TOOL_RESULT_LINE_MAX = 200;
/** JSON arguments are clipped here before either limit above applies. */
const TOOL_ARGS_MAX = 120;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

export function formatArgs(input: Record<string, unknown>): string {
  return truncate(JSON.stringify(input), TOOL_ARGS_MAX);
}

export interface ToolUseSummary {
  /** Line shown in the transcript. */
  text: string;
  /** Full form, present only when `text` had to drop something. */
  fullText?: string;
  /** Line shown in the working indicator while the tool runs. */
  status: string;
}

export function summariseToolUse(name: string, input: Record<string, unknown>): ToolUseSummary {
  const args = formatArgs(input);
  const text = `${name}(${truncate(args, TOOL_CALL_LINE_MAX)})`;
  const full = `${name}(${args})`;
  const status = `${name}(${truncate(args, TOOL_CALL_STATUS_MAX)})`;
  // No collapse hint when nothing was actually hidden.
  return text === full ? { text, status } : { text, fullText: full, status };
}

export interface ToolResultSummary {
  kind: EntryKind;
  text: string;
  fullText?: string;
}

export function summariseToolResult(
  name: string,
  output: string,
  isError: boolean,
): ToolResultSummary {
  const kind: EntryKind = isError ? 'error' : 'tool-result';
  // Short single-line output is shown verbatim — collapsing it would hide
  // nothing and cost a line of hint.
  if (output.length <= TOOL_RESULT_LINE_MAX && !output.includes('\n')) {
    return { kind, text: `${name} → ${output}` };
  }
  const firstLine = output.split('\n')[0] ?? '';
  return {
    kind,
    text: `${name} → ${truncate(firstLine, TOOL_RESULT_LINE_MAX)}`,
    fullText: `${name} →\n${output}`,
  };
}

/** The "[+N more …]" line under a collapsed entry. */
export function renderCollapseHint(short: string, full: string): string {
  const hiddenLines = Math.max(0, full.split('\n').length - short.split('\n').length);
  if (hiddenLines > 0) return t('transcript.expandHintLines', { count: hiddenLines });
  return t('transcript.expandHintChars', { count: full.length - short.length });
}

/**
 * Ctrl+O — reveal the most recent collapsed entry by appending an expanded
 * copy rather than mutating the original.
 *
 * Committed entries live inside Ink's <Static>, which never re-renders what it
 * has already painted; flipping an entry's state in place would mean
 * re-rendering the whole transcript, which is exactly the flicker this avoids.
 *
 * Returns the same array instance when there is nothing to expand, so a
 * useState setter can bail out instead of re-rendering.
 */
export function expandLastCollapsed(entries: readonly Entry[], now = Date.now()): Entry[] {
  let target: Entry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const candidate = entries[i];
    if (candidate?.fullText !== undefined) {
      target = candidate;
      break;
    }
  }
  if (!target) return entries as Entry[];
  return [
    ...entries,
    {
      id: `${entries.length}_${now}_x`,
      kind: 'system',
      text: `expanded: ${target.text}\n${target.fullText}`,
    },
  ];
}

/**
 * Match "Label   value" — at least two spaces separate the columns. Also
 * match "label: value" with one space if the colon is glued to the label.
 */
export function parseKeyValue(line: string): { label: string; gap: string; value: string } | null {
  const m = /^([A-Za-z][\w/.\- ]{0,18})(\s{2,})(\S.*)$/.exec(line);
  if (m?.[1] && m[2] && m[3]) return { label: m[1], gap: m[2], value: m[3] };
  const c = /^([A-Za-z][\w/.\- ]{0,18}:)(\s+)(\S.*)$/.exec(line);
  if (c?.[1] && c[2] && c[3]) return { label: c[1], gap: c[2], value: c[3] };
  return null;
}
