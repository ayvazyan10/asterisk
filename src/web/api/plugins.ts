// The plugin surface, described without running any of it.
//
// This endpoint deliberately does not import a single plugin. A plugin is a
// TypeScript module loaded into the agent's own process with the run of the
// place — the secret store, the tool registry, the permission gate — and
// importing one to find out what it is called would execute it. So everything
// here is what can be known from the configuration and from stat(2): is the
// path absolute once `~` is expanded, does the file exist, when did it change.
//
// What is actually *loaded* is a different question, and this process cannot
// answer it: plugins are initialised by whichever process runs the agent — the
// daemon, or the REPL — and the panel is neither. `/plugins` in the REPL and
// the daemon log are where that answer lives today. Wiring the runtime report
// back to the panel is on the roadmap; claiming to know it here would be a
// lie the page would tell every time the daemon was restarted.
//
// Writes go through the ordinary settings PATCH, which already validates every
// field against its own slice of the schema and audits the change. There is no
// second write path for `plugins.enabled` and `plugins.load`.

import { statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

import { readConfig } from '../../config/store.ts';
import { expandHome } from '../../utils/path.ts';
import { type Handler, json } from '../http.ts';

/** Extensions the loader's dynamic import can actually resolve. */
const IMPORTABLE = new Set(['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts']);

interface PluginEntry {
  /** Exactly as configured, `~` and all — this is what the user typed. */
  path: string;
  /** After expandHome + resolve, which is what the loader will import. */
  resolved: string;
  exists: boolean;
  /**
   * Absolute once `~` is expanded. The loader refuses anything else, because a
   * relative path resolves against whatever directory the daemon was started
   * in — which is not a property of the configuration.
   */
  absolute: boolean;
  /** An extension node can import. A directory or a .json is a load error. */
  importable: boolean;
  bytes: number | null;
  modified: number | null;
  /** Listed twice — the loader imports it once and reports the duplicate. */
  duplicate: boolean;
}

function describe(raw: string, seen: Set<string>): PluginEntry {
  const trimmed = raw.trim();
  const expanded = expandHome(trimmed);
  const resolved = resolve(expanded);
  const duplicate = seen.has(resolved);
  seen.add(resolved);

  let bytes: number | null = null;
  let modified: number | null = null;
  let exists = false;
  try {
    const info = statSync(resolved);
    // A directory is not importable and would fail at load; saying "exists"
    // about one would send the reader looking for a different problem.
    exists = info.isFile();
    if (exists) {
      bytes = info.size;
      modified = info.mtimeMs;
    }
  } catch {
    // Missing, or unreadable. Either way there is nothing to import.
  }

  return {
    path: trimmed,
    resolved,
    exists,
    absolute: isAbsolute(expanded),
    importable: IMPORTABLE.has(extname(resolved)),
    bytes,
    modified,
    duplicate,
  };
}

export const getPlugins: Handler = ({ db }) => {
  const config = readConfig(db);
  const seen = new Set<string>();
  const entries = config.plugins.load.map((raw) => describe(raw, seen));

  return json({
    enabled: config.plugins.enabled,
    entries,
    // Stated by the API rather than assumed by the page: the panel is not the
    // process that loads plugins, and a reader deserves to be told that once
    // rather than left to infer it from an empty list.
    runtimeKnown: false,
  });
};
