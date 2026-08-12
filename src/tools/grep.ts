// Grep tool — wraps ripgrep when available, falls back to system grep -r.

import { execa } from 'execa';
import { type Tool, err, ok } from './types.ts';

async function hasRipgrep(): Promise<boolean> {
  try {
    await execa('rg', ['--version'], { reject: false });
    return true;
  } catch {
    return false;
  }
}

export const grepTool: Tool = {
  name: 'Grep',
  description:
    'Search file contents for a regex. Returns matching lines with file:line prefix. Uses ripgrep when present, otherwise grep -rn.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern.' },
      path: { type: 'string', description: 'Directory or file to search (default cwd).' },
      glob: { type: 'string', description: 'Optional include glob (rg --glob).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : '';
    if (!pattern) return err('pattern is required');
    const path = typeof input['path'] === 'string' ? input['path'] : '.';
    const glob = typeof input['glob'] === 'string' ? input['glob'] : undefined;

    try {
      const useRg = await hasRipgrep();
      const cmd = useRg ? 'rg' : 'grep';
      const args = useRg
        ? (() => {
            const a = ['--line-number', '--no-heading', '--color=never'];
            if (glob) a.push('--glob', glob);
            a.push(pattern, path);
            return a;
          })()
        : ['-rn', '-E', pattern, path];

      const baseOpts = { reject: false as const, encoding: 'utf8' as const };
      const execOpts = opts?.signal ? { ...baseOpts, cancelSignal: opts.signal } : baseOpts;
      const result = await execa(cmd, args, execOpts);
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      // grep / rg return exit 1 on no-match; surface that politely.
      if (result.exitCode === 1 && !stderr) {
        return ok('(no matches)');
      }
      const out = stdout || stderr || '';
      return ok(out.length > 30000 ? `${out.slice(0, 30000)}\n[truncated]` : out);
    } catch (e) {
      return err(`Grep failed: ${(e as Error).message}`);
    }
  },
};
