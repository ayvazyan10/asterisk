// Recovering tool calls a model wrote as prose instead of emitting on the
// tool-call channel.
//
// Models without native tool support — and models whose server was started
// without a tool-aware chat template, which is the common llama.cpp
// misconfiguration — still *try* to call tools. They just put the call in the
// content stream. Two shapes observed on a live llama-server (b1-726704a,
// gemma-4-26b) with the tools described in the system prompt only:
//
//   <|tool_call>call:Read(path="/etc/hostname")<tool_call|>
//   ```json
//   {"name": "Read", "arguments": {"path": "/etc/hostname"}}
//   ```
//
// Before this module both were handed to the user verbatim as the assistant's
// final answer, and the turn ended having done nothing.
//
// Known limit, so it is not mistaken for coverage: `call:Name(...)` pseudo-code
// is recovered only INSIDE tool-call markers, which is where the models that
// emit it put it. A bare parenthesised call in free prose is left alone on
// purpose — scanning for it at top level would match ordinary sentences that
// happen to name a tool, and the cost of a false call is higher than the cost
// of a missed one.
//
// The guard against false positives is that a recovered name must resolve to a
// tool that actually exists. A model quoting JSON in an explanation cannot
// trigger a call unless the JSON names a real tool in a real call envelope,
// and the loop only asks for recovery when the response carried no native tool
// calls at all.

import type { ToolUseBlock } from '../types/messages.ts';
import {
  canonicalToolName,
  extractFirstJsonValue,
  parseJsonLoosely,
  parseToolArguments,
} from './tool-repair.ts';

export interface RecoveredToolCalls {
  calls: ToolUseBlock[];
  /** What is left of the message once the call markup is removed. */
  text: string;
}

/** Matches every tool-call marker dialect: <tool_call>, </tool_call>,
 *  <|tool_call|>, <|/tool_call|>, and the mixed <|tool_call> … <tool_call|>
 *  that gemma emits. */
const MARKER = /<\s*\|?\s*\/?\s*tool[_-]?call\s*\|?\s*>/gi;
const MISTRAL_PREFIX = /\[TOOL_CALLS\]/i;
const FENCE = /```[\w-]*[ \t]*\r?\n([\s\S]*?)```/g;

let sequence = 0;

/**
 * Scans assistant text for tool calls. Returns null when there is nothing to
 * recover, so the caller's happy path costs one regex test.
 */
export function recoverToolCallsFromText(
  text: string,
  available: readonly string[],
): RecoveredToolCalls | null {
  if (!text.trim() || available.length === 0) return null;

  const fromMarkers = recoverFromMarkers(text, available);
  if (fromMarkers) return fromMarkers;

  const fromMistral = recoverFromMistral(text, available);
  if (fromMistral) return fromMistral;

  const fromFences = recoverFromFences(text, available);
  if (fromFences) return fromFences;

  return recoverFromBareJson(text, available);
}

// --- envelope scanners ---------------------------------------------------

function recoverFromMarkers(text: string, available: readonly string[]): RecoveredToolCalls | null {
  MARKER.lastIndex = 0;
  if (!MARKER.test(text)) return null;
  MARKER.lastIndex = 0;

  // Segments alternate outside/inside, because the split consumes markers.
  const segments = text.split(MARKER);
  const calls: ToolUseBlock[] = [];
  const outside: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    if (i % 2 === 0) {
      outside.push(segment);
      continue;
    }
    const parsed = parseCallBody(segment, available);
    if (parsed.length > 0) calls.push(...parsed);
    // An inside-segment we could not read is dropped: it is call markup the
    // user should not be shown, and re-emitting it would just confuse them.
  }
  if (calls.length === 0) return null;
  return { calls, text: outside.join(' ').trim() };
}

function recoverFromMistral(text: string, available: readonly string[]): RecoveredToolCalls | null {
  const marker = MISTRAL_PREFIX.exec(text);
  if (!marker) return null;
  const after = text.slice(marker.index + marker[0].length);
  const json = extractFirstJsonValue(after);
  if (json === null) return null;
  const calls = parseCallBody(json, available);
  if (calls.length === 0) return null;
  return { calls, text: text.slice(0, marker.index).trim() };
}

function recoverFromFences(text: string, available: readonly string[]): RecoveredToolCalls | null {
  FENCE.lastIndex = 0;
  const calls: ToolUseBlock[] = [];
  let remaining = '';
  let cursor = 0;
  for (let match = FENCE.exec(text); match !== null; match = FENCE.exec(text)) {
    const body = match[1] ?? '';
    const parsed = parseCallBody(body, available);
    if (parsed.length === 0) continue;
    calls.push(...parsed);
    remaining += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  if (calls.length === 0) return null;
  remaining += text.slice(cursor);
  return { calls, text: remaining.trim() };
}

function recoverFromBareJson(
  text: string,
  available: readonly string[],
): RecoveredToolCalls | null {
  const trimmed = text.trim();
  // Only when the whole message *is* the call. A JSON object quoted inside a
  // sentence is far more likely to be an example than an attempted call.
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  const calls = parseCallBody(trimmed, available);
  if (calls.length === 0) return null;
  return { calls, text: '' };
}

// --- call body parsing ---------------------------------------------------

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function_name', 'recipient_name'] as const;
const ARG_KEYS = ['arguments', 'parameters', 'params', 'args', 'input', 'tool_input'] as const;

function parseCallBody(body: string, available: readonly string[]): ToolUseBlock[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  const json =
    trimmed.startsWith('{') || trimmed.startsWith('[')
      ? parseJsonLoosely(trimmed)
      : parseJsonLoosely(extractFirstJsonValue(trimmed) ?? trimmed);
  const fromJson = blocksFromJson(json, available);
  if (fromJson.length > 0) return fromJson;

  return blocksFromCallSyntax(trimmed, available);
}

function blocksFromJson(value: unknown, available: readonly string[]): ToolUseBlock[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => blocksFromJson(entry, available));
  }
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;

  // OpenAI's own wire shape, echoed back as text by models trained on it.
  const fn = record['function'];
  if (typeof fn === 'object' && fn !== null) {
    return blocksFromJson(fn, available);
  }

  const rawName = firstString(record, NAME_KEYS);
  if (rawName === undefined) return [];
  const name = canonicalToolName(rawName, available);
  if (name === null) return [];

  const rawArgs = firstDefined(record, ARG_KEYS);
  const input = parseToolArguments(rawArgs, name);
  return [block(name, input)];
}

/** `call:Read(path="/etc/hostname")` — pseudo-code rather than JSON, observed
 *  from gemma inside its own tool-call markers. Parsed only when the name is a
 *  real tool, so ordinary prose containing parentheses cannot match. */
function blocksFromCallSyntax(text: string, available: readonly string[]): ToolUseBlock[] {
  // The name may be namespaced (`filesystem:Read`) — canonicalToolName
  // resolves the tail, so accept the separators here rather than failing to
  // match the call at all.
  const match = /^(?:call\s*[:=]\s*)?([A-Za-z_][\w.:/-]*)\s*\(([\s\S]*)\)\s*$/.exec(text.trim());
  if (!match) return [];
  const rawName = match[1] ?? '';
  const name = canonicalToolName(rawName, available);
  if (name === null) return [];

  const input: Record<string, unknown> = {};
  for (const part of splitArguments(match[2] ?? '')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part
      .slice(0, eq)
      .trim()
      .replace(/^["']|["']$/g, '');
    const raw = part.slice(eq + 1).trim();
    if (!key) continue;
    input[key] = literalValue(raw);
  }
  return [block(name, input)];
}

/** Splits `a="x, y", b=2` on the commas that separate arguments only. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function literalValue(raw: string): unknown {
  const parsed = parseJsonLoosely(raw);
  if (parsed !== undefined) return parsed;
  return raw.replace(/^["']|["']$/g, '');
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function block(name: string, input: Record<string, unknown>): ToolUseBlock {
  sequence += 1;
  return { type: 'tool_use', id: `text_call_${sequence}`, name, input };
}
