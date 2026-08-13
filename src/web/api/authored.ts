// Read-only reports for the authored content the loaders resolve.
//
// The same lesson skills taught, applied to the three kinds beside it: what is
// in the directory and what the agent actually loads are different sets, and
// showing the first while calling it the second is how a file sits there for
// months doing nothing.
//
//   Rules   are layered common → per-language → flat, and the per-language
//           layer only loads when the detected language matches. A rule under
//           rules/python/ is inert in a TypeScript project, and nothing in the
//           file tree says so.
//   Agents  resolve 27 bundled definitions plus yours. The panel listed only
//           the files, so the 27 the Agent tool can actually dispatch to were
//           invisible — and a file whose body is empty is dropped in silence.
//   Souls   layer user → session → project, and only the layers that exist
//           apply.
//
// Writing still goes through /api/content: these endpoints answer "what is in
// effect", not "let me change it". Skills needed its own write path because
// its file format is a contract; these are plain markdown.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { BUNDLED_AGENTS } from '../../agents/bundled.ts';
import { type AgentType, loadAgents } from '../../agents/loader.ts';
import { type ProjectLang, type Rule, detectProjectLang, loadRules } from '../../rules/loader.ts';
import { loadSouls } from '../../soul/loader.ts';
import { type Handler, HttpError, json } from '../http.ts';

function asteriskHome(): string {
  return process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
}

interface DiskFile {
  path: string;
  /** Path shown to the reader, relative to the root it was found under. */
  rel: string;
  bytes: number;
}

/** Every .md under a root, one level deep or nested, with sizes. */
function markdownUnder(root: string, base = root): DiskFile[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: DiskFile[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith('.')) continue;
    const abs = join(root, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...markdownUnder(abs, base));
    else if (entry.toLowerCase().endsWith('.md')) {
      out.push({ path: abs, rel: relative(base, abs), bytes: stat.size });
    }
  }
  return out;
}

/**
 * Why a file that is sitting right there did not become a rule. The language
 * layer is the interesting case and the one nothing else reports: a rule under
 * rules/python/ is perfectly valid and completely inert in a Go project.
 */
function ruleSkipReason(file: DiskFile, lang: ProjectLang): string {
  const parts = file.rel.split(/[\\/]/);
  const dir = parts.length > 1 ? (parts[0] as string) : '';

  if (dir && LANG_DIRS.has(dir) && dir !== lang) {
    const reads = lang === 'unknown' ? 'no language it recognises' : lang;
    return `written for ${dir}, and this project reads as ${reads}`;
  }
  // A layer reads the files directly inside it and does not descend.
  if (parts.length > 2) {
    return 'nested too deep — a layer reads only the files directly inside it';
  }
  if (dir && !LANG_DIRS.has(dir) && dir !== 'common') {
    return `"${dir}" is not a layer — rules load from common/, a language folder, or the top level`;
  }
  return 'empty, or whitespace only — a rule with no content is skipped';
}

// The language directory names loadRules knows about. Anything else nested
// under rules/ is somebody's own folder and is reported plainly.
const LANG_DIRS = new Set<string>([
  'typescript',
  'javascript',
  'python',
  'golang',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'dart',
  'swift',
  'php',
  'perl',
  'cpp',
  'ruby',
  'web',
]);

export const getRulesReport: Handler = () => {
  const cwd = process.cwd();
  const lang = detectProjectLang(cwd);
  const userRoot = join(asteriskHome(), 'rules');
  const projectRoot = join(cwd, '.asterisk', 'rules');

  const loaded: Rule[] = loadRules(cwd);
  const inEffect = new Set(loaded.map((r) => r.path));

  const onDisk = [
    ...markdownUnder(userRoot).map((f) => ({ ...f, scope: 'user' as const })),
    ...markdownUnder(projectRoot).map((f) => ({ ...f, scope: 'project' as const })),
  ];

  return json({
    lang,
    langPinned: Boolean(process.env['ASTERISK_LANG']),
    roots: { user: userRoot, project: projectRoot },
    rules: loaded.map((r) => ({
      name: r.name,
      path: r.path,
      scope: r.scope,
      layer: r.layer ?? 'flat',
      bytes: r.content.length,
    })),
    inert: onDisk
      .filter((f) => !inEffect.has(f.path))
      .map((f) => ({
        path: f.path,
        rel: f.rel,
        scope: f.scope,
        bytes: f.bytes,
        reason: ruleSkipReason(f, lang),
      })),
  });
};

export const getAgentsReport: Handler = () => {
  const cwd = process.cwd();
  const agents: AgentType[] = loadAgents(cwd);
  const resolved = new Set(agents.filter((a) => a.scope !== 'bundled').map((a) => a.path));

  const userRoot = join(asteriskHome(), 'agents');
  const projectRoot = join(cwd, '.asterisk', 'agents');
  const onDisk = [
    ...markdownUnder(userRoot).map((f) => ({ ...f, scope: 'user' as const })),
    ...markdownUnder(projectRoot).map((f) => ({ ...f, scope: 'project' as const })),
  ];

  // Your definition of a bundled name replaces it, which is the documented
  // way to customise one — but it is worth saying out loud, because the
  // bundled version simply stops existing and nothing else reports that.
  const bundledNames = new Set(BUNDLED_AGENTS.map((a) => a.name));
  const shadowed = agents
    .filter((a) => a.scope !== 'bundled' && bundledNames.has(a.name))
    .map((a) => a.name);

  return json({
    roots: { user: userRoot, project: projectRoot },
    agents: agents.map((a) => ({
      name: a.name,
      description: a.description,
      scope: a.scope,
      path: a.path,
      allowedTools: a.allowedTools ?? null,
      maxTurns: a.maxTurns ?? null,
      promptBytes: a.prompt.length,
    })),
    shadowed,
    inert: onDisk
      .filter((f) => !resolved.has(f.path))
      .map((f) => ({
        path: f.path,
        rel: f.rel,
        scope: f.scope,
        bytes: f.bytes,
        // loadAgents drops a definition with no body without saying so.
        reason: 'no prompt body — everything after the frontmatter is the prompt',
      })),
    counts: {
      loaded: agents.length,
      bundled: agents.filter((a) => a.scope === 'bundled').length,
      user: agents.filter((a) => a.scope === 'user').length,
      project: agents.filter((a) => a.scope === 'project').length,
    },
  });
};

/**
 * One agent with its prompt. Bundled definitions have no file, so this is the
 * only way to read the 27 the Agent tool can dispatch to — which is the whole
 * reason they stopped being invisible.
 */
export const getAgentDetail: Handler = ({ params }) => {
  const name = params[0] ?? '';
  const agent = loadAgents(process.cwd()).find((a) => a.name === name);
  if (!agent) throw new HttpError(`no agent named "${name}"`, 404);
  return json({
    name: agent.name,
    description: agent.description,
    scope: agent.scope,
    path: agent.path,
    allowedTools: agent.allowedTools ?? null,
    maxTurns: agent.maxTurns ?? null,
    prompt: agent.prompt,
    editable: agent.scope !== 'bundled',
  });
};

export const getSoulsReport: Handler = () => {
  const cwd = process.cwd();
  // No session here: the panel is not a chat, so the session layer is listed
  // from disk rather than resolved.
  const active = loadSouls(cwd);
  const sessionFiles = markdownUnder(join(asteriskHome(), 'souls'));

  return json({
    roots: { user: asteriskHome(), sessions: join(asteriskHome(), 'souls') },
    active: active.map((s) => ({ scope: s.scope, path: s.path, bytes: s.content.length })),
    sessions: sessionFiles.map((f) => ({ path: f.path, rel: f.rel, bytes: f.bytes })),
  });
};
