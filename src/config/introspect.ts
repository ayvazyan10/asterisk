// Derives a UI-renderable description of every setting from the Zod schema.
//
// The point is that the web control panel never hard-codes a form. Add a field
// to ConfigSchema and it shows up in the browser with the right widget, the
// right validation bounds and the right default — no second place to update.
//
// This reads Zod v3 internals (`_def`), which are not a public API. The
// dependency is pinned to ^3.24 and every access is defensive: an unrecognised
// node degrades to a plain text input rather than throwing.

import type { z } from 'zod';

import { ConfigSchema } from './schema.ts';

export type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string-array'
  | 'number-array'
  | 'unknown';

export interface FieldDescriptor {
  /** Dotted path into the config tree, e.g. `bots.telegram.streamMode`. */
  path: string;
  /** Last path segment, humanised: `streamMode` -> `Stream mode`. */
  label: string;
  /** Top-level group the field belongs to, used for UI sectioning. */
  group: string;
  kind: FieldKind;
  description?: string;
  default?: unknown;
  /** Allowed values, for `enum`. */
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** Set when the string must parse as a URL. */
  format?: 'url';
  optional?: boolean;
}

/** Config keys backed by dedicated tables, described separately from scalars. */
const COLLECTION_KEYS = new Set(['mcpServers', 'hooks']);

interface ZodDef {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  defaultValue?: () => unknown;
  values?: readonly string[];
  type?: z.ZodTypeAny;
  checks?: Array<{ kind: string; value?: number }>;
  shape?: () => Record<string, z.ZodTypeAny>;
}

function defOf(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def ?? {};
}

/** Strips ZodDefault/ZodOptional/ZodNullable wrappers, collecting what they carry. */
function unwrap(schema: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  default?: unknown;
  optional: boolean;
} {
  let inner = schema;
  let dflt: unknown;
  let optional = false;

  // Wrappers nest arbitrarily (.optional().default(x) etc.), so loop rather
  // than special-casing one level.
  for (let guard = 0; guard < 10; guard++) {
    const def = defOf(inner);
    if (def.typeName === 'ZodDefault' && def.innerType) {
      if (dflt === undefined && typeof def.defaultValue === 'function') {
        try {
          dflt = def.defaultValue();
        } catch {
          // A default that throws is a schema bug, but it shouldn't stop the
          // whole registry from being built.
        }
      }
      inner = def.innerType;
      continue;
    }
    if ((def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') && def.innerType) {
      optional = true;
      inner = def.innerType;
      continue;
    }
    break;
  }

  return { inner, default: dflt, optional };
}

/** Words that should keep a fixed casing rather than being sentence-cased. */
const ACRONYMS: Record<string, string> = {
  url: 'URL',
  urls: 'URLs',
  id: 'ID',
  ids: 'IDs',
  api: 'API',
  html: 'HTML',
  json: 'JSON',
  ms: '(ms)',
  // Vendor spellings. Without these the settings page titles a whole section
  // "Openai compatible", which is a section heading nobody wrote.
  openai: 'OpenAI',
  mcp: 'MCP',
  oauth: 'OAuth',
};

/** `streamThrottleMs` -> `Stream throttle (ms)`, `baseUrl` -> `Base URL`. */
function humanise(segment: string): string {
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());

  const [first, ...rest] = words;
  if (first === undefined) return segment;
  const head = Object.values(ACRONYMS).includes(first)
    ? first
    : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(' ');
}

function numericBounds(def: ZodDef): Pick<FieldDescriptor, 'min' | 'max' | 'integer'> {
  const out: Pick<FieldDescriptor, 'min' | 'max' | 'integer'> = {};
  for (const check of def.checks ?? []) {
    if (check.kind === 'int') out.integer = true;
    if (check.kind === 'min' && typeof check.value === 'number') out.min = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') out.max = check.value;
  }
  return out;
}

function describeLeaf(path: string, schema: z.ZodTypeAny): FieldDescriptor | undefined {
  const { inner, default: dflt, optional } = unwrap(schema);
  const def = defOf(inner);
  const segments = path.split('.');
  const base: FieldDescriptor = {
    path,
    label: humanise(segments[segments.length - 1] ?? path),
    group: segments[0] ?? path,
    kind: 'unknown',
    ...(schema.description ? { description: schema.description } : {}),
    ...(inner.description && !schema.description ? { description: inner.description } : {}),
    ...(dflt !== undefined ? { default: dflt } : {}),
    ...(optional ? { optional: true } : {}),
  };

  switch (def.typeName) {
    case 'ZodString': {
      const isUrl = (def.checks ?? []).some((c) => c.kind === 'url');
      return { ...base, kind: 'string', ...(isUrl ? { format: 'url' as const } : {}) };
    }
    case 'ZodNumber':
      return { ...base, kind: 'number', ...numericBounds(def) };
    case 'ZodBoolean':
      return { ...base, kind: 'boolean' };
    case 'ZodEnum':
      return { ...base, kind: 'enum', options: [...(def.values ?? [])] };
    case 'ZodArray': {
      const element = def.type ? unwrap(def.type).inner : undefined;
      const elementType = element ? defOf(element).typeName : undefined;
      if (elementType === 'ZodNumber') return { ...base, kind: 'number-array' };
      if (elementType === 'ZodString') return { ...base, kind: 'string-array' };
      // Arrays of objects are collections; they are not scalar settings.
      return undefined;
    }
    default:
      return { ...base, kind: 'unknown' };
  }
}

function walk(schema: z.ZodTypeAny, prefix: string, out: FieldDescriptor[]): void {
  const { inner } = unwrap(schema);
  const def = defOf(inner);

  if (def.typeName === 'ZodObject' && typeof def.shape === 'function') {
    for (const [key, child] of Object.entries(def.shape())) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!prefix && COLLECTION_KEYS.has(key)) continue;
      walk(child, path, out);
    }
    return;
  }

  const leaf = describeLeaf(prefix, schema);
  if (leaf) out.push(leaf);
}

let cached: FieldDescriptor[] | undefined;

/**
 * Every scalar setting in ConfigSchema, in declaration order. Computed once —
 * the schema is static for the life of the process.
 */
export function settingsRegistry(): FieldDescriptor[] {
  if (!cached) {
    const out: FieldDescriptor[] = [];
    walk(ConfigSchema, '', out);
    cached = out;
  }
  return cached;
}

/** Looks up one field by dotted path. */
export function describeField(path: string): FieldDescriptor | undefined {
  return settingsRegistry().find((f) => f.path === path);
}

/**
 * Registry entries bucketed by top-level group, preserving declaration order.
 *
 * `label` runs the key through the same humaniser the field labels use, so the
 * panel shows "OpenAI-compatible" and "Output style" rather than shouting the
 * schema key back at the reader. The raw key stays as `group` because it is
 * what the anchors and the dotted paths are built from.
 */
export function settingsByGroup(): Array<{
  group: string;
  label: string;
  fields: FieldDescriptor[];
}> {
  const groups: Array<{ group: string; label: string; fields: FieldDescriptor[] }> = [];
  for (const field of settingsRegistry()) {
    let bucket = groups.find((g) => g.group === field.group);
    if (!bucket) {
      bucket = { group: field.group, label: humanise(field.group), fields: [] };
      groups.push(bucket);
    }
    bucket.fields.push(field);
  }
  return groups;
}

/**
 * Validates a single field's value against its slice of the schema, so the API
 * can reject one bad edit without materialising a whole config object.
 */
export function validateField(
  path: string,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const segments = path.split('.');
  let current: z.ZodTypeAny = ConfigSchema;

  for (const segment of segments) {
    const def = defOf(unwrap(current).inner);
    if (def.typeName !== 'ZodObject' || typeof def.shape !== 'function') {
      return { ok: false, error: `no such setting: ${path}` };
    }
    const next = def.shape()[segment];
    if (!next) return { ok: false, error: `no such setting: ${path}` };
    current = next;
  }

  const result = current.safeParse(value);
  if (result.success) return { ok: true };
  const issue = result.error.issues[0];
  return { ok: false, error: issue ? issue.message : 'invalid value' };
}
