// `/diff`, `/review` and `/code` — read-only git and code-intelligence views.
//
// Split out of registry.ts to keep it under the repo's 800-line limit.
// Pure move — no behaviour changed.

import { execSync } from 'node:child_process';

import { codeIntelTool } from '../tools/code-intel.ts';
import type { SlashCommand } from './registry.ts';
import { escapeRegex, quote, shellJoin, truncate } from './text.ts';

export const diffCommand: SlashCommand = {
  name: '/diff',
  description: 'Show a structured git diff summary',
  usage: '/diff [staged|all|path]',
  execute(_ctx, args) {
    return formatDiffCommand(args.trim());
  },
};

export const reviewCommand: SlashCommand = {
  name: '/review',
  description: 'Review current git changes for risk patterns',
  usage: '/review [staged|all|path]',
  execute(_ctx, args) {
    return formatDiffCommand(args.trim(), true);
  },
};

export const codeCommand: SlashCommand = {
  name: '/code',
  description: 'Code intelligence: symbols, definitions, references, diagnostics',
  usage: '/code [symbols|def|refs|diagnostics] [query|file line character]',
  async execute(_ctx, args) {
    return runCodeCommand(args.trim());
  },
};

function formatDiffCommand(raw: string, review = false): string {
  const { mode, path } = parseDiffArgs(raw);
  const args = ['diff', '--no-ext-diff', '--stat'];
  if (mode === 'staged') args.push('--staged');
  if (mode === 'all') args.push('HEAD');
  if (path) args.push('--', path);

  const patchArgs = ['diff', '--no-ext-diff', '--unified=80'];
  if (mode === 'staged') patchArgs.push('--staged');
  if (mode === 'all') patchArgs.push('HEAD');
  if (path) patchArgs.push('--', path);

  try {
    const stat = execSync(`git ${shellJoin(args)}`, { encoding: 'utf8', timeout: 10000 }).trim();
    const patch = execSync(`git ${shellJoin(patchArgs)}`, { encoding: 'utf8', timeout: 10000 });
    if (!patch.trim()) return '(no changes)';
    if (!review) return [stat || 'Diff', '', truncate(patch, 50000)].join('\n');
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = patch
      .split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const hints = reviewHints(patch);
    return [
      `Review · ${mode}${path ? ` · ${path}` : ''} · +${added} / -${removed}`,
      '',
      stat,
      '',
      'Risk hints:',
      ...(hints.length
        ? hints.map((h) => `  ${h}`)
        : ['  No obvious high-signal risk patterns found.']),
      '',
      truncate(patch, 50000),
    ].join('\n');
  } catch (e) {
    return `git diff failed: ${(e as Error).message}`;
  }
}

function parseDiffArgs(raw: string): { mode: 'unstaged' | 'staged' | 'all'; path?: string } {
  const arg = raw.trim();
  if (!arg) return { mode: 'unstaged' };
  if (arg === 'staged' || arg === '--staged') return { mode: 'staged' };
  if (arg === 'all' || arg === 'head' || arg === 'HEAD') return { mode: 'all' };
  return { mode: 'unstaged', path: arg };
}

async function runCodeCommand(raw: string): Promise<string> {
  const [verb = '', ...rest] = raw.split(/\s+/).filter(Boolean);
  const query = rest.join(' ');
  try {
    if (verb === 'diagnostics' || verb === 'diag') {
      if (rest[0]) {
        const result = await codeIntelTool.execute({ action: 'diagnostics', file: rest[0] });
        return result.output;
      }
      return (
        truncate(execSync('bun run typecheck', { encoding: 'utf8', timeout: 120000 }), 30000) ||
        'diagnostics passed'
      );
    }
    if (
      (verb === 'def' || verb === 'definition' || verb === 'refs' || verb === 'references') &&
      rest.length >= 3
    ) {
      const [file, lineRaw, characterRaw] = rest;
      const line = Number.parseInt(lineRaw ?? '', 10);
      const character = Number.parseInt(characterRaw ?? '', 10);
      if (file && Number.isFinite(line) && Number.isFinite(character)) {
        const result = await codeIntelTool.execute({
          action: verb === 'refs' || verb === 'references' ? 'references' : 'definition',
          file,
          line,
          character,
        });
        return result.output;
      }
    }
    if (verb === 'symbols' && rest.length === 1 && /\.(tsx?|jsx?)$/.test(rest[0] ?? '')) {
      const result = await codeIntelTool.execute({ action: 'symbols', file: rest[0] });
      return result.output;
    }
    if (!query && verb !== 'symbols') {
      return 'usage: /code [symbols|def|refs|diagnostics] [query]';
    }
    if (verb === 'symbols') {
      const pattern = query
        ? definitionPattern(query)
        : String.raw`^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+[A-Za-z0-9_$]+`;
      return rgCommand(pattern);
    }
    if (verb === 'def' || verb === 'definition') return rgCommand(definitionPattern(query));
    if (verb === 'refs' || verb === 'references') return rgCommand(escapeRegex(query));
    return 'usage: /code [symbols|def|refs|diagnostics] [query]';
  } catch (e) {
    const error = e as { stdout?: string; stderr?: string; message?: string };
    return truncate([error.stdout, error.stderr, error.message].filter(Boolean).join('\n'), 30000);
  }
}

function rgCommand(pattern: string): string {
  const cmd = `rg --line-number --no-heading --color=never --glob '!node_modules' --glob '!dist' ${quote(pattern)} .`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    return truncate(out || '(no matches)', 30000);
  } catch (e) {
    // rg exits 1 when nothing matched, which execSync raises. The `|| '(no
    // matches)'` above was unreachable, so a search with no hits reported
    // "Command failed: rg …" as if the tool were broken. Exit 2 is a real
    // error — a bad pattern, an unreadable path — and still surfaces.
    const status = (e as { status?: number }).status;
    if (status === 1) return '(no matches)';
    // 127 is the shell's "command not found". Saying so beats surfacing
    // `/bin/sh: 1: rg: not found` and leaving the user to work it out.
    if (status === 127) return 'ripgrep (rg) is not installed — /code needs it. See /doctor.';
    throw e;
  }
}

function definitionPattern(query: string): string {
  const q = escapeRegex(query);
  return String.raw`^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+${q}\b`;
}

function reviewHints(diff: string): string[] {
  const addedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  const checks: Array<[RegExp, string]> = [
    [/\bTODO\b|\bFIXME\b/i, 'New TODO/FIXME markers were added.'],
    [/\bconsole\.log\b/, 'New console.log calls were added.'],
    [/\bany\b/, 'New TypeScript any usage appears in added lines.'],
    [/\beval\s*\(/, 'New eval usage appears in added lines.'],
    [/\bexecSync\s*\(|\bspawn\s*\(|\bexeca\s*\(/, 'New process execution code was added.'],
    [/\bprocess\.env\b/, 'New environment-variable reads were added.'],
    [
      /\bwriteFileSync\b|\bunlinkSync\b|\brmSync\b/,
      'New synchronous filesystem mutation code was added.',
    ],
  ];
  return checks
    .filter(([pattern]) => addedLines.some((line) => pattern.test(line)))
    .map(([, msg]) => msg);
}
