// Strips grammar-hostile JSON Schema keywords out of tool schemas before they
// reach an OpenAI-compatible endpoint.
//
// llama.cpp's `--jinja` server turns every tool's JSON Schema into a GBNF
// grammar for constrained decoding, and two unrelated keywords in that
// conversion path each take the WHOLE turn down with HTTP 400 — not just the
// one tool carrying the offending schema. Both were found against a live
// llama-server, in this order:
//
// 1. `pattern` nested under an object property. The server's regex→GBNF
//    conversion breaks on it and the journal shows:
//
//      parse: error parsing grammar: unknown escape at \d\d" [2468] ...
//      failed to parse grammar
//
//    Minimal repro:
//
//      FAILS (400): { type: 'object', properties: { wrap: { type: 'object',
//        properties: { x: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } } } }
//      PASSES (200): the same schema with `pattern` removed.
//      PASSES (200): the same `\d` pattern when `x` is a TOP-level property
//        instead of nested under `wrap`.
//
// 2. A large `minLength`/`maxLength`/`minItems`/`maxItems`. llama.cpp expands
//    a length or count bound into that many repeated grammar rules, literally,
//    and blows its own complexity ceiling once the bound is big enough. After
//    `pattern` alone was stripped from the daemon's real 139-tool request
//    (46 built-in + 93 MCP), the request still failed, now with:
//
//      parse: error parsing grammar: number of rules that are going to be
//      repeated multiplied by the new repetition exceeds sane defaults,
//      please reduce the number of repetitions or rule complexity
//
//    The trigger is the SIZE of the bound, not nesting — probed nested under
//    one level of object property, against a live llama-server:
//
//      nested maxLength 2000  -> 400 (the "exceeds sane defaults" error)
//      nested maxLength 40    -> 200
//      nested minLength 1     -> 200
//      nested maxItems 50     -> 200
//      nested minItems 1      -> 200
//
//    There is no safe threshold to special-case here — a different server
//    build, a different bound, or a deeper nesting could move the line — so
//    all four bound keywords are dropped unconditionally rather than kept up
//    to some guessed-safe number.
//
// All five keywords below are validation-only: none of them constrains what
// a *correct* tool call looks like, so dropping them costs nothing for tool
// calling specifically, whatever it might cost a validator reading the same
// schema for a different purpose.
//
//   pattern, minLength, maxLength, minItems, maxItems
//
// Deliberately NOT dropped: `enum`, `const`, `format`, `minimum`, `maximum`,
// `multipleOf`. Each was probed nested (one level under an object property)
// against the live server and every one passed — they are not part of this
// bug. `enum` in particular genuinely steers a small model toward a valid
// value; dropping it would make tool calls *worse*, not safer. Do not add to
// the set without a reproducing failure the way the five above have one.
//
// This is deliberately NOT `\d` → `[0-9]` rewriting, and not a size cap on
// `maxLength` either. Either would "fix" the exact case in the bug report
// and leave the actual bug — llama.cpp's grammar conversion breaking on
// certain nested schemas — in place for the next shorthand class, the next
// quantifier, or the next bound that happens to trip it. Dropping the
// keyword removes the whole class of failure instead of chasing one member
// of it.
//
// The Anthropic provider does not go through this: Anthropic's API doesn't
// compile tool schemas into a decoding grammar, so it has no equivalent
// failure mode and keeping every one of these keywords there costs nothing.
//
// Immutability matters here specifically because a `ToolDefinition`'s
// `input_schema` is the same object every turn, owned by the tool registry —
// this function must never hand back a schema with a hole punched in the
// original.

/** Keywords whose GBNF expansion can take the whole /chat/completions
 *  request down. See the module header for the two failures each was found
 *  against. Never add a keyword here on suspicion alone — reproduce the
 *  failure against a live server first, the way these five were. */
const GRAMMAR_HOSTILE_KEYWORDS = [
  'pattern',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
] as const;

/** Keys whose value is itself a schema, an array of schemas, or a boolean
 *  schema (e.g. `additionalProperties: false`) — recursed into directly. */
const SCHEMA_VALUED_KEYS = [
  'items',
  'prefixItems',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

/** Keys whose value is a map from a name (or, for `patternProperties`, a
 *  regex) to a schema. The map's own keys are data, never one of the
 *  grammar-hostile keywords above, and must survive untouched even when a
 *  key happens to spell one of them — Asterisk's own Grep tool has a
 *  property named exactly "pattern". */
const SCHEMA_MAP_KEYS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Removes every grammar-hostile keyword from a JSON Schema value, recursively.
 *
 * Accepts anything — a schema object, an array of schemas, or a bare
 * primitive — because the function is used both as the public entry point
 * and as its own recursion step over values whose shape is not yet known
 * (`items` may be a schema or a tuple of schemas; `additionalProperties` may
 * be a schema or a plain boolean).
 *
 * Always returns a new value. Object and array inputs are rebuilt from
 * scratch rather than mutated in place, so the schema handed in — which the
 * tool registry reuses across every turn — is left exactly as it was.
 */
export function stripGrammarHostileKeywords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGrammarHostileKeywords);
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if ((GRAMMAR_HOSTILE_KEYWORDS as readonly string[]).includes(key)) continue;

    if ((SCHEMA_MAP_KEYS as readonly string[]).includes(key) && isPlainObject(val)) {
      out[key] = stripFromSchemaMap(val);
    } else if ((SCHEMA_VALUED_KEYS as readonly string[]).includes(key)) {
      out[key] = stripGrammarHostileKeywords(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Sanitises every value of a name→schema map while leaving its keys alone. */
function stripFromSchemaMap(map: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(map)) out[name] = stripGrammarHostileKeywords(schema);
  return out;
}
