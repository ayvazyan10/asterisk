// Repairing tool calls that small local models get wrong.
//
// A frontier model emits `arguments` as a compact, schema-valid JSON object.
// A 7B quant at q4 does not, reliably. The shapes seen in practice, all of
// which used to reach a tool as garbage or reach the model back as a
// misleading error:
//
//   arguments: '```json\n{"path":"/etc/hostname"}\n```'   fenced
//   arguments: 'Sure! {"path": "/etc/hostname"}'          wrapped in prose
//   arguments: "{'path': '/etc/hostname',}"               python-ish
//   arguments: '"{\\"path\\":\\"/x\\"}"'                  double-encoded
//   arguments: '"/etc/hostname"'                          bare scalar
//   arguments: { arguments: { path: '/x' } }              double-wrapped
//   arguments: { limit: '10' }                            stringified number
//
// Everything here is a *pure* normalisation over the model's output. Nothing
// here executes anything; the agent loop decides what to do with a call it
// could not repair. The deliberate rule is that an unrepairable call becomes a
// tool_result the model can read and correct, never a thrown error that ends
// the turn — a small model that gets one clear correction usually gets the
// second attempt right, and a model that never sees the error never will.

/** Sentinel keys carried on the tool input when arguments could not be parsed.
 *  The provider cannot produce a tool_result — only the loop can — so the
 *  failure travels as data on the block until the loop turns it into one. */
export const MALFORMED_ARGUMENTS_KEY = '__malformed_arguments';
export const MALFORMED_TOOL_KEY = '__tool';

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface SchemaProperty {
  type?: string;
  description?: string;
}

// --- argument parsing ----------------------------------------------------

export function markMalformedArguments(raw: string, toolName: string): Record<string, unknown> {
  return { [MALFORMED_ARGUMENTS_KEY]: raw, [MALFORMED_TOOL_KEY]: toolName };
}

/** Reads the sentinel back, or null when the input parsed cleanly. */
export function readMalformedArguments(
  input: Record<string, unknown>,
): { raw: string; tool: string } | null {
  const raw = input[MALFORMED_ARGUMENTS_KEY];
  if (typeof raw !== 'string') return null;
  const tool = input[MALFORMED_TOOL_KEY];
  return { raw, tool: typeof tool === 'string' ? tool : '' };
}

/**
 * Turns whatever the model put in `arguments` into an object.
 *
 * Accepts the already-decoded object form (Ollama's native shape) as well as
 * the JSON text form (every OpenAI-compatible endpoint). Returns the malformed
 * sentinel rather than throwing when nothing works.
 */
export function parseToolArguments(raw: unknown, toolName: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return wrapNonObject(raw);
  if (typeof raw !== 'string') return { value: raw };

  const trimmed = raw.trim();
  if (!trimmed) return {};

  const parsed = parseJsonLoosely(trimmed);
  if (parsed === undefined) return markMalformedArguments(trimmed, toolName);
  return wrapNonObject(parsed);
}

/** Schema-shaped values pass through; anything else is wrapped so the caller
 *  always gets an object and `coerceToolInput` gets a chance to place it. */
function wrapNonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * JSON.parse with the repairs small models actually need, tried in order of
 * how likely each is to be the real intent. Returns undefined when the text
 * cannot be read as JSON at all — never a partially-invented object, because
 * guessing at a tool's arguments is worse than telling the model to retry.
 */
export function parseJsonLoosely(text: string): unknown {
  for (const candidate of repairCandidates(text)) {
    try {
      const value = JSON.parse(candidate) as unknown;
      // Double-encoded: the model stringified its arguments twice, so the
      // first parse yields the JSON text rather than the object.
      if (typeof value === 'string') {
        const inner = value.trim();
        if (inner.startsWith('{') || inner.startsWith('[')) {
          try {
            return JSON.parse(inner) as unknown;
          } catch {
            // The inner text was not JSON after all — keep the string.
          }
        }
      }
      return value;
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

function* repairCandidates(text: string): Generator<string> {
  yield text;

  const unfenced = stripCodeFence(text);
  if (unfenced !== text) yield unfenced;

  const body = unfenced;
  const extracted = extractFirstJsonValue(body);
  if (extracted !== null && extracted !== body) yield extracted;

  const base = extracted ?? body;
  const depythoned = base
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
  if (depythoned !== base) yield depythoned;

  const noTrailingCommas = depythoned.replace(/,(\s*[}\]])/g, '$1');
  if (noTrailingCommas !== depythoned) yield noTrailingCommas;

  // Single quotes only as a last resort, and only when there is no double
  // quote to destroy — `{'msg': "it's fine"}` must not become nonsense.
  if (noTrailingCommas.includes("'") && !noTrailingCommas.includes('"')) {
    yield noTrailingCommas.replace(/'/g, '"');
  }
}

/** Removes a ```lang … ``` wrapper. Models fence their arguments constantly. */
export function stripCodeFence(text: string): string {
  const match = /^```[\w-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(text.trim());
  return match?.[1]?.trim() ?? text;
}

/**
 * Pulls the first balanced JSON object or array out of surrounding prose.
 * String-aware, so a brace inside a quoted value cannot close the scan early.
 */
export function extractFirstJsonValue(text: string): string | null {
  const start = firstIndexOfAny(text, ['{', '[']);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function firstIndexOfAny(text: string, chars: readonly string[]): number {
  let best = -1;
  for (const ch of chars) {
    const at = text.indexOf(ch);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

// --- shape coercion ------------------------------------------------------

/** Keys a model reaches for when it wraps its arguments one level too deep. */
const WRAPPER_KEYS = ['arguments', 'parameters', 'params', 'args', 'input'] as const;

/**
 * Nudges a structurally-wrong-but-recoverable input into the shape the schema
 * asks for. Only unambiguous repairs are made: anything that would require
 * guessing which parameter the model meant is left alone so the loop can send
 * back a precise error instead.
 */
export function coerceToolInput(
  input: Record<string, unknown>,
  schema: ToolInputSchema | undefined,
): Record<string, unknown> {
  if (!schema) return input;
  let out = unwrapNesting(input, schema);
  out = placeBareValue(out, schema);
  return coerceScalars(out, schema);
}

/** `{ arguments: { path } }` → `{ path }`, but only when the wrapper key is
 *  not itself a parameter of the tool. */
function unwrapNesting(
  input: Record<string, unknown>,
  schema: ToolInputSchema,
): Record<string, unknown> {
  const keys = Object.keys(input);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only === undefined) return input;
  if (!WRAPPER_KEYS.includes(only as (typeof WRAPPER_KEYS)[number])) return input;
  if (Object.hasOwn(schema.properties, only)) return input;
  const inner = input[only];
  if (typeof inner === 'string') {
    const parsed = parseJsonLoosely(inner);
    if (isPlainObject(parsed)) return parsed;
    return input;
  }
  if (isPlainObject(inner)) return inner;
  return input;
}

/** A bare scalar (`"/etc/hostname"` instead of `{"path": "/etc/hostname"}`)
 *  arrives wrapped as `{ value }`. When the tool takes exactly one required
 *  parameter there is only one place it can go. */
function placeBareValue(
  input: Record<string, unknown>,
  schema: ToolInputSchema,
): Record<string, unknown> {
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'value') return input;
  if (Object.hasOwn(schema.properties, 'value')) return input;
  const required = schema.required ?? [];
  const target = required.length === 1 ? required[0] : undefined;
  if (target === undefined) return input;
  return { [target]: input['value'] };
}

/** `"10"` where the schema says number, `"{...}"` where it says object. Local
 *  models stringify everything; the schema says what it should have been. */
function coerceScalars(
  input: Record<string, unknown>,
  schema: ToolInputSchema,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const coerced = coerceOne(value, propertyType(schema, key));
    if (coerced !== value) changed = true;
    out[key] = coerced;
  }
  return changed ? out : input;
}

function coerceOne(value: unknown, type: string | undefined): unknown {
  if (typeof value !== 'string' || type === undefined) return value;
  const trimmed = value.trim();
  if (type === 'number' || type === 'integer') {
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return value;
    return Number(trimmed);
  }
  if (type === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return value;
  }
  if (type === 'object' || type === 'array') {
    const parsed = parseJsonLoosely(trimmed);
    if (type === 'object' && isPlainObject(parsed)) return parsed;
    if (type === 'array' && Array.isArray(parsed)) return parsed;
    return value;
  }
  return value;
}

function propertyType(schema: ToolInputSchema, key: string): string | undefined {
  const prop = schema.properties[key] as SchemaProperty | undefined;
  return typeof prop?.type === 'string' ? prop.type : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- validation ----------------------------------------------------------

/**
 * Required parameters the model did not supply.
 *
 * Absent only — an empty string is a *value*. `Edit` deletes text by passing
 * `newString: ""` and `Write` creates an empty file with `content: ""`, so
 * treating empty as missing would reject two legitimate calls to catch a
 * mistake the tools already report on their own.
 */
export function missingRequired(
  input: Record<string, unknown>,
  schema: ToolInputSchema | undefined,
): string[] {
  if (!schema?.required) return [];
  return schema.required.filter((key) => input[key] === undefined || input[key] === null);
}

/** One-line rendering of the parameter list, for error messages sent back to
 *  the model. The schema itself was already in the prompt; repeating it next
 *  to the mistake is what makes a small model fix the call rather than repeat
 *  it verbatim. */
export function describeSchema(schema: ToolInputSchema | undefined): string {
  if (!schema) return '(no parameters)';
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(schema.properties).map(([key, raw]) => {
    const prop = raw as SchemaProperty | undefined;
    const type = typeof prop?.type === 'string' ? prop.type : 'any';
    return `${key}: ${type}${required.has(key) ? ' (required)' : ''}`;
  });
  return parts.length > 0 ? parts.join(', ') : '(no parameters)';
}

const RAW_ECHO_LIMIT = 400;

/** The message a model gets back when its `arguments` were not JSON. */
export function malformedArgumentsMessage(
  toolName: string,
  raw: string,
  schema: ToolInputSchema | undefined,
): string {
  const echo = raw.length > RAW_ECHO_LIMIT ? `${raw.slice(0, RAW_ECHO_LIMIT)}…` : raw;
  return [
    `${toolName} was NOT run: its arguments were not valid JSON.`,
    `Received: ${echo}`,
    'Call it again with arguments as one JSON object — no prose, no markdown fence.',
    `Parameters: ${describeSchema(schema)}`,
  ].join('\n');
}

/** The message a model gets back when required parameters are absent. */
export function missingArgumentsMessage(
  toolName: string,
  missing: readonly string[],
  input: Record<string, unknown>,
  schema: ToolInputSchema | undefined,
): string {
  const provided = Object.keys(input);
  return [
    `${toolName} was NOT run: missing required ${
      missing.length === 1 ? 'parameter' : 'parameters'
    } ${missing.map((m) => `"${m}"`).join(', ')}.`,
    `You sent: ${provided.length > 0 ? provided.join(', ') : '(nothing)'}`,
    `Parameters: ${describeSchema(schema)}`,
  ].join('\n');
}

// --- tool names ----------------------------------------------------------

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Maps a name the model emitted onto a real tool when the only difference is
 * casing or punctuation — `bash`, `BASH`, `browser_navigate` all resolve.
 *
 * This is not guesswork: the normalised forms have to be equal, and the match
 * has to be unique. Inventing a mapping from `read_file` to `Read` would be
 * guessing; folding `read` onto `Read` is undoing a formatting slip that
 * quantised models make on almost every turn.
 */
export function canonicalToolName(name: string, available: readonly string[]): string | null {
  if (available.includes(name)) return name;
  const direct = uniqueNormalisedMatch(name, available);
  if (direct !== null) return direct;
  // Namespaced forms: `filesystem:Read`, `functions.Read`, `builtin/Read`.
  // gemma-4-26b produced `call:filesystem:Read(path=…)` unprompted on a live
  // llama-server, and OpenAI-trained models reach for the `functions.` prefix.
  // Resolving the last segment is still an exact match, just of the tail.
  const segments = name.split(/[.:/]/);
  const tail = segments[segments.length - 1];
  if (segments.length < 2 || tail === undefined) return null;
  return uniqueNormalisedMatch(tail, available);
}

function uniqueNormalisedMatch(name: string, available: readonly string[]): string | null {
  const target = normaliseName(name);
  if (!target) return null;
  const matches = available.filter((candidate) => normaliseName(candidate) === target);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Best-effort "did you mean" list for a name that matched nothing. Ranked by
 *  shared prefix and substring overlap — cheap, and enough to point a model at
 *  `Read` when it asked for `read_file`. */
export function suggestToolNames(name: string, available: readonly string[], limit = 3): string[] {
  const target = normaliseName(name);
  if (!target) return [];
  const scored = available
    .map((candidate) => ({ candidate, score: nameScore(target, normaliseName(candidate)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

function nameScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 50 + Math.min(a.length, b.length);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return shared >= 3 ? shared : 0;
}
