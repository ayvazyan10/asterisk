// Rules — markdown files auto-loaded into the system prompt so the user can
// give Asterisk persistent project- or user-level instructions.
//
// Two flavours of layout are supported, in this resolution order (later
// wins on repetition):
//
//   1. flat     — ~/.asterisk/rules/*.md             (user-global)
//                 <cwd>/.asterisk/rules/*.md          (project-local)
//                 <cwd>/ASTERISK.md                   (project root marker)
//   2. layered  — ~/.asterisk/rules/common/*.md      (universal — always loaded)
//                 ~/.asterisk/rules/<lang>/*.md       (language-specific —
//                                                     loaded when the project
//                                                     matches that language)
//                 <cwd>/.asterisk/rules/common/*.md   (project, common)
//                 <cwd>/.asterisk/rules/<lang>/*.md   (project, language)
//
// Auto-detection of the project's primary language: package.json → typescript
// or javascript, pyproject.toml / requirements.txt → python, go.mod → golang,
// Cargo.toml → rust, pom.xml / build.gradle → java, composer.json → php,
// Gemfile → ruby, *.tsx / *.jsx index files → web. The user can pin the
// detection by setting ASTERISK_LANG=<name> in secrets.env / shell env.
//
// Anyone with a `flat` setup gets the same behaviour as before — there's no
// migration required. Layered setup adds value when the user installs a
// shared rule set with common + per-language overrides.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Rule {
  name: string;
  path: string;
  scope: 'user' | 'project';
  /** Layered rules carry a layer hint so /rules can show provenance. */
  layer?: 'flat' | 'common' | 'lang';
  content: string;
}

export type ProjectLang =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'golang'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'dart'
  | 'swift'
  | 'php'
  | 'perl'
  | 'cpp'
  | 'ruby'
  | 'web'
  | 'unknown';

/** Detect the primary language of the project rooted at cwd. Pinned by
 *  ASTERISK_LANG when set; otherwise inferred from manifest files. */
export function detectProjectLang(cwd: string = process.cwd()): ProjectLang {
  const pinned = (process.env['ASTERISK_LANG'] ?? '').trim().toLowerCase();
  if (pinned) return normaliseLang(pinned);

  const has = (p: string): boolean => existsSync(join(cwd, p));
  if (has('package.json')) {
    // TS-ish project if there's a tsconfig.json or any *.ts/.tsx in the tree.
    if (has('tsconfig.json')) return 'typescript';
    return 'javascript';
  }
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt') || has('Pipfile'))
    return 'python';
  if (has('go.mod')) return 'golang';
  if (has('Cargo.toml')) return 'rust';
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java';
  if (has('composer.json')) return 'php';
  if (has('Gemfile')) return 'ruby';
  if (has('Package.swift')) return 'swift';
  if (has('pubspec.yaml')) return 'dart';
  if (has('CMakeLists.txt') || has('Makefile')) return 'cpp';
  return 'unknown';
}

function normaliseLang(s: string): ProjectLang {
  const map: Record<string, ProjectLang> = {
    ts: 'typescript',
    typescript: 'typescript',
    js: 'javascript',
    javascript: 'javascript',
    py: 'python',
    python: 'python',
    go: 'golang',
    golang: 'golang',
    rs: 'rust',
    rust: 'rust',
    java: 'java',
    kt: 'kotlin',
    kotlin: 'kotlin',
    cs: 'csharp',
    csharp: 'csharp',
    dart: 'dart',
    swift: 'swift',
    php: 'php',
    perl: 'perl',
    cpp: 'cpp',
    'c++': 'cpp',
    ruby: 'ruby',
    rb: 'ruby',
    web: 'web',
    frontend: 'web',
  };
  return map[s] ?? 'unknown';
}

interface SearchSpec {
  scope: Rule['scope'];
  layer: NonNullable<Rule['layer']>;
  dir: string;
  files?: string[];
}

export function loadRules(cwd: string = process.cwd()): Rule[] {
  const userRoot = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  const lang = detectProjectLang(cwd);
  const userRulesDir = join(userRoot, 'rules');
  const projectRulesDir = join(cwd, '.asterisk', 'rules');

  // Layered (common + per-language) takes priority if the layered dirs
  // exist. Flat files in the same parent still load — they're treated as
  // additional flat rules to keep backward compat.
  const sources: SearchSpec[] = [];

  // 1. User-global, common layer — universal rules.
  sources.push({ scope: 'user', layer: 'common', dir: join(userRulesDir, 'common') });
  // 2. User-global, per-language layer.
  if (lang !== 'unknown') {
    sources.push({ scope: 'user', layer: 'lang', dir: join(userRulesDir, lang) });
  }
  // 3. User-global, flat — files directly under ~/.asterisk/rules/.
  sources.push({ scope: 'user', layer: 'flat', dir: userRulesDir });
  // 4. Project-local, common.
  sources.push({ scope: 'project', layer: 'common', dir: join(projectRulesDir, 'common') });
  // 5. Project-local, per-language.
  if (lang !== 'unknown') {
    sources.push({ scope: 'project', layer: 'lang', dir: join(projectRulesDir, lang) });
  }
  // 6. Project-local, flat.
  sources.push({ scope: 'project', layer: 'flat', dir: projectRulesDir });
  // 7. ASTERISK.md as a project root marker — treat as a single flat rule.
  sources.push({ scope: 'project', layer: 'flat', dir: cwd, files: ['ASTERISK.md'] });

  const rules: Rule[] = [];
  const seen = new Set<string>();

  for (const spec of sources) {
    if (spec.files) {
      for (const file of spec.files) {
        const path = join(spec.dir, file);
        if (seen.has(path)) continue;
        if (existsSync(path) && statSync(path).isFile()) {
          rules.push(makeRule(spec.scope, spec.layer, path));
          seen.add(path);
        }
      }
      continue;
    }
    if (!existsSync(spec.dir) || !statSync(spec.dir).isDirectory()) continue;
    for (const entry of readdirSync(spec.dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const path = join(spec.dir, entry);
      if (seen.has(path)) continue;
      if (statSync(path).isFile()) {
        rules.push(makeRule(spec.scope, spec.layer, path));
        seen.add(path);
      }
    }
  }
  return rules.filter((r) => r.content.length > 0);
}

function makeRule(scope: Rule['scope'], layer: NonNullable<Rule['layer']>, path: string): Rule {
  const content = readFileSync(path, 'utf8').trim();
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? path;
  return { name, path, scope, layer, content };
}

export function rulesToPromptSection(rules: readonly Rule[]): string {
  if (rules.length === 0) return '';
  const blocks = rules.map((r) => {
    const tag =
      r.layer && r.layer !== 'flat' ? `${r.scope}/${r.layer}/${r.name}` : `${r.scope}/${r.name}`;
    return `## ${tag}\n${r.content}`;
  });
  return `# Rules (loaded from disk)\n${blocks.join('\n\n')}`;
}
