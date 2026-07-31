// Markdown content endpoints — rules, skills, agents and souls.
//
// These are plain files under ~/.asterisk that the agent reads into its system
// prompt. The panel exposes them as a small editor, which means accepting a
// caller-supplied path: every request therefore goes through `resolveInside`,
// which refuses anything that escapes its content root.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { audit, type Handler, HttpError, json, readJsonObject } from '../http.ts';

export type ContentKind = 'rules' | 'skills' | 'agents' | 'souls';

interface KindSpec {
  /** Directory the kind is rooted at, relative to ASTERISK_HOME. */
  dir: string;
  /** Extra files outside `dir` that belong to this kind, relative to the home root. */
  extras?: string[];
  description: string;
}

const KINDS: Record<ContentKind, KindSpec> = {
  rules: {
    dir: 'rules',
    description: 'Layered instructions spliced into every system prompt.',
  },
  skills: {
    dir: 'skills',
    description: 'SKILL.md files the agent can load on demand.',
  },
  agents: {
    dir: 'agents',
    description: 'Sub-agent definitions available to the Agent tool.',
  },
  souls: {
    dir: 'souls',
    extras: ['SOUL.md'],
    description: 'Persona files. SOUL.md applies globally; souls/*.md are per-session.',
  },
};

function asteriskHome(): string {
  return process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
}

export function isContentKind(value: string): value is ContentKind {
  return Object.hasOwn(KINDS, value);
}

/**
 * Resolves `relPath` beneath `base`, refusing traversal, absolute paths and
 * symlinks that point outside. Returns the absolute path.
 */
function resolveInside(base: string, relPath: string): string {
  if (relPath.includes('\0')) throw new HttpError('invalid path');
  if (relPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new HttpError('path must be relative');
  }
  if (relPath.split(/[\\/]/).some((s) => s === '..')) {
    throw new HttpError('path must not traverse upwards');
  }

  const absolute = resolve(base, relPath);
  const withinLexically = absolute === base || absolute.startsWith(base + sep);
  if (!withinLexically) throw new HttpError('path escapes its content directory');

  // A symlink inside the tree could still point out of it. Check the deepest
  // existing ancestor, since the target itself may not exist yet on a write.
  // If the root does not exist there is nothing to traverse, and climbing
  // above it would compare the wrong directories.
  if (existsSync(base)) {
    const realBase = realpathSync(base);
    let probe = absolute;
    while (!existsSync(probe) && probe.length > base.length) probe = dirname(probe);
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      if (real !== realBase && !real.startsWith(realBase + sep)) {
        throw new HttpError('path escapes its content directory via a symlink');
      }
    }
  }

  return absolute;
}

interface ContentEntry {
  path: string;
  bytes: number;
  modified: number;
}

function walkMarkdown(root: string, prefix = ''): ContentEntry[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: ContentEntry[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith('.')) continue;
    const abs = join(root, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      // A dangling symlink or a file deleted mid-walk shouldn't abort the list.
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(abs, rel));
    } else if (entry.toLowerCase().endsWith('.md')) {
      out.push({ path: rel, bytes: stat.size, modified: stat.mtimeMs });
    }
  }
  return out;
}

/** Lists every editable file across all kinds, with their roots. */
export const listContent: Handler = ({ params }) => {
  const requested = params[0];
  const kinds = requested
    ? [requested].filter(isContentKind)
    : (Object.keys(KINDS) as ContentKind[]);
  if (requested && kinds.length === 0) throw new HttpError(`unknown content kind: ${requested}`, 404);

  const home = asteriskHome();
  return json({
    kinds: kinds.map((kind) => {
      const spec = KINDS[kind];
      const base = join(home, spec.dir);
      const files = walkMarkdown(base);

      for (const extra of spec.extras ?? []) {
        const abs = join(home, extra);
        if (!existsSync(abs) || !statSync(abs).isFile()) continue;
        const stat = statSync(abs);
        files.unshift({ path: `${EXTRA_PREFIX}${extra}`, bytes: stat.size, modified: stat.mtimeMs });
      }

      return { kind, root: base, description: spec.description, files };
    }),
  });
};

/**
 * Files that sit outside their kind's directory are addressed with this
 * prefix. A literal `../` cannot be used: the WHATWG URL parser collapses it
 * before the request ever reaches the router, so `souls/../SOUL.md` would
 * arrive as `SOUL.md`.
 */
const EXTRA_PREFIX = '@';

/**
 * Maps a kind plus a caller-supplied relative path to a validated absolute
 * path. Extras are addressed as `@NAME` and resolved against the home root
 * with the same containment check.
 */
function contentPath(kind: ContentKind, relPath: string): string {
  const spec = KINDS[kind];
  const home = asteriskHome();

  if (relPath.startsWith(EXTRA_PREFIX)) {
    const name = relPath.slice(EXTRA_PREFIX.length);
    if (!(spec.extras ?? []).includes(name)) {
      throw new HttpError(`"${relPath}" is not an editable file for kind "${kind}"`);
    }
    return resolveInside(home, name);
  }

  if (!relPath.toLowerCase().endsWith('.md')) {
    throw new HttpError('only .md files are editable');
  }
  return resolveInside(join(home, spec.dir), relPath);
}

function kindFrom(params: string[]): { kind: ContentKind; rel: string } {
  const kind = params[0];
  if (!kind || !isContentKind(kind)) throw new HttpError(`unknown content kind: ${kind}`, 404);
  const rel = params.slice(1).join('/');
  if (!rel) throw new HttpError('file path is required');
  return { kind, rel };
}

export const readContent: Handler = ({ params }) => {
  const { kind, rel } = kindFrom(params);
  const abs = contentPath(kind, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new HttpError(`no such file: ${rel}`, 404);
  }
  return json({ kind, path: rel, content: readFileSync(abs, 'utf8') });
};

export const writeContent: Handler = async ({ db, params, req }) => {
  const { kind, rel } = kindFrom(params);
  const body = await readJsonObject(req);
  const content = body['content'];
  if (typeof content !== 'string') throw new HttpError('"content" must be a string');

  const abs = contentPath(kind, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  audit(db, 'content.write', `${kind}/${rel}`, { bytes: content.length });

  return json({ ok: true, kind, path: rel, bytes: content.length });
};

export const deleteContent: Handler = ({ db, params }) => {
  const { kind, rel } = kindFrom(params);
  const abs = contentPath(kind, rel);
  if (!existsSync(abs)) throw new HttpError(`no such file: ${rel}`, 404);

  rmSync(abs);

  // A skill lives in its own directory; remove the shell once its file is gone.
  if (kind === 'skills') {
    const dir = dirname(abs);
    const base = join(asteriskHome(), KINDS.skills.dir);
    if (relative(base, dir) !== '' && existsSync(dir) && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
    }
  }

  audit(db, 'content.delete', `${kind}/${rel}`);
  return json({ ok: true });
};
