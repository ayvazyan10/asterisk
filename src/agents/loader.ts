// Specialized sub-agent type loader. Combines bundled types with any
// user-installed (~/.asterisk/agents/<name>.md) or project-local
// (<cwd>/.asterisk/agents/<name>.md) overrides.
//
// File format (markdown with frontmatter):
//   ---
//   name: code-reviewer
//   description: General code review.
//   allowedTools: [Read, Grep, Glob, Bash, Edit]   # optional, comma list ok
//   maxTurns: 12                                   # optional
//   ---
//   <body becomes the agent's system prompt>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BUNDLED_AGENTS } from './bundled.ts';
import type { AgentType } from './types.ts';

export type { AgentType } from './types.ts';

export function loadAgents(cwd: string = process.cwd()): AgentType[] {
  const byName = new Map<string, AgentType>();
  for (const a of BUNDLED_AGENTS) byName.set(a.name, a);

  const userRoot = process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk');
  const dirs: { scope: 'user' | 'project'; root: string }[] = [
    { scope: 'user', root: join(userRoot, 'agents') },
    { scope: 'project', root: join(cwd, '.asterisk', 'agents') },
  ];

  for (const { scope, root } of dirs) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root).sort()) {
      if (!entry.endsWith('.md')) continue;
      const file = join(root, entry);
      if (!statSync(file).isFile()) continue;
      const parsed = parseAgentMarkdown(readFileSync(file, 'utf8'), entry.replace(/\.md$/, ''));
      if (!parsed.prompt) continue;
      const next: AgentType = {
        ...parsed,
        scope,
        path: file,
      };
      byName.set(parsed.name, next);
    }
  }

  const ordered = [...byName.values()].sort((a, b) => {
    const scopeOrder: Record<AgentType['scope'], number> = {
      bundled: 0,
      user: 1,
      project: 2,
    };
    if (scopeOrder[a.scope] !== scopeOrder[b.scope]) {
      return scopeOrder[a.scope] - scopeOrder[b.scope];
    }
    return a.name.localeCompare(b.name);
  });
  return ordered;
}

export function findAgent(name: string, cwd: string = process.cwd()): AgentType | undefined {
  return loadAgents(cwd).find((a) => a.name === name);
}

interface ParsedAgent {
  name: string;
  description: string;
  prompt: string;
  allowedTools?: readonly string[];
  maxTurns?: number;
}

export function parseAgentMarkdown(raw: string, fallbackName: string): ParsedAgent {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!fmMatch) {
    return { name: fallbackName, description: '', prompt: raw.trim() };
  }
  const fmBlock = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.+)$/.exec(t);
    if (m) {
      const key = (m[1] ?? '').toLowerCase();
      const value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
      fm[key] = value;
    }
  }
  const out: ParsedAgent = {
    name: fm['name'] ?? fallbackName,
    description: fm['description'] ?? '',
    prompt: body.trim(),
  };
  const tools = fm['allowedtools'] ?? fm['allowed_tools'] ?? '';
  if (tools) {
    const list = tools
      .replace(/^\[|\]$/g, '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) out.allowedTools = list;
  }
  const turns = fm['maxturns'] ?? fm['max_turns'];
  if (turns) {
    const n = Number.parseInt(turns, 10);
    if (Number.isFinite(n) && n > 0) out.maxTurns = n;
  }
  return out;
}
