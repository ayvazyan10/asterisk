// Rules — markdown files auto-loaded into the system prompt so the user can
// give Asterisk persistent project- or user-level instructions.
//
//   ~/.asterisk/rules/*.md           user-global rules
//   <cwd>/.asterisk/rules/*.md       project-local rules
//   <cwd>/ASTERISK.md                project root rule (optional)
//
// All discovered files are concatenated; project rules win in case of
// repetition because they're listed last in the prompt.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Rule {
  name: string;
  path: string;
  scope: 'user' | 'project';
  content: string;
}

interface SearchSpec {
  scope: Rule['scope'];
  dir: string;
  files?: string[];
}

export function loadRules(cwd: string = process.cwd()): Rule[] {
  const userRoot = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  const sources: SearchSpec[] = [
    { scope: 'user', dir: join(userRoot, 'rules') },
    { scope: 'project', dir: join(cwd, '.asterisk', 'rules') },
    // ASTERISK.md as a project root marker — treat as a single rule file.
    { scope: 'project', dir: cwd, files: ['ASTERISK.md'] },
  ];

  const rules: Rule[] = [];
  for (const spec of sources) {
    if (spec.files) {
      for (const file of spec.files) {
        const path = join(spec.dir, file);
        if (existsSync(path) && statSync(path).isFile()) {
          rules.push(makeRule(spec.scope, path));
        }
      }
      continue;
    }
    if (!existsSync(spec.dir) || !statSync(spec.dir).isDirectory()) continue;
    for (const entry of readdirSync(spec.dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const path = join(spec.dir, entry);
      if (statSync(path).isFile()) rules.push(makeRule(spec.scope, path));
    }
  }
  return rules.filter((r) => r.content.length > 0);
}

function makeRule(scope: Rule['scope'], path: string): Rule {
  const content = readFileSync(path, 'utf8').trim();
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? path;
  return { name, path, scope, content };
}

export function rulesToPromptSection(rules: readonly Rule[]): string {
  if (rules.length === 0) return '';
  const blocks = rules.map((r) => `## ${r.scope}/${r.name}\n${r.content}`);
  return `# Rules (loaded from disk)\n${blocks.join('\n\n')}`;
}
