import { execa } from 'execa';
import { type Tool, err, ok } from './types.ts';

type Mode = 'unstaged' | 'staged' | 'all';

export const diffReviewTool: Tool = {
  name: 'DiffReview',
  description: 'Inspect git changes and produce a structured diff summary with review-risk hints.',
  input_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['unstaged', 'staged', 'all'],
        description: 'Which git diff to inspect. Defaults to unstaged.',
      },
      path: {
        type: 'string',
        description: 'Optional pathspec to limit the diff.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, opts) {
    const mode = (typeof input['mode'] === 'string' ? input['mode'] : 'unstaged') as Mode;
    const path =
      typeof input['path'] === 'string' && input['path'].trim() ? input['path'].trim() : undefined;
    if (!['unstaged', 'staged', 'all'].includes(mode)) {
      return err('mode must be one of: unstaged, staged, all');
    }
    try {
      const diff = await getDiff(mode, path, opts?.signal);
      if (!diff.trim()) return ok('(no changes)');
      return ok(formatReview(diff));
    } catch (e) {
      return err(`DiffReview failed: ${(e as Error).message}`);
    }
  },
};

async function getDiff(mode: Mode, path?: string, signal?: AbortSignal): Promise<string> {
  const args = ['diff', '--no-ext-diff', '--unified=80'];
  if (mode === 'staged') args.push('--staged');
  if (mode === 'all') args.push('HEAD');
  if (path) args.push('--', path);
  const baseOpts = { reject: false as const, encoding: 'utf8' as const };
  const execOpts = signal ? { ...baseOpts, cancelSignal: signal } : baseOpts;
  const result = await execa('git', args, execOpts);
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function formatReview(diff: string): string {
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((m) => m[2]);
  const added = countLines(diff, '+');
  const removed = countLines(diff, '-');
  const hints = reviewHints(diff);
  const lines = [
    `Diff summary: ${files.length} file${files.length === 1 ? '' : 's'} changed, +${added} / -${removed}`,
  ];
  if (files.length > 0) {
    lines.push('');
    lines.push('Files:');
    for (const f of files.slice(0, 40)) lines.push(`  ${f}`);
    if (files.length > 40) lines.push(`  ... ${files.length - 40} more`);
  }
  lines.push('');
  lines.push('Review hints:');
  if (hints.length === 0) lines.push('  No obvious high-signal risk patterns found.');
  else for (const h of hints) lines.push(`  ${h}`);
  lines.push('');
  lines.push('Patch:');
  lines.push(truncate(diff));
  return lines.join('\n');
}

function countLines(diff: string, prefix: '+' | '-'): number {
  return diff
    .split('\n')
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}

function reviewHints(diff: string): string[] {
  const hints: string[] = [];
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
  for (const [pattern, message] of checks) {
    if (addedLines.some((line) => pattern.test(line))) hints.push(message);
  }
  return hints;
}

function truncate(value: string): string {
  return value.length > 50000 ? `${value.slice(0, 50000)}\n[truncated]` : value;
}
