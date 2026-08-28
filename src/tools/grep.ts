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

/**
 * Builds argv for the chosen search binary, with `--` marking the end of
 * options in both branches. Without it, a `pattern` starting with `-` (a
 * plausible thing to grep for — a CLI flag, a YAML front-matter marker) gets
 * parsed as an option instead of the search term: `-foo` reads to ripgrep as
 * `-f oo` (`-f <patterns-file>` with an argument of `oo`), which fails with
 * an unrelated "No such file" error rather than searching for `-foo`.
 */
export function buildGrepArgs(
  useRg: boolean,
  pattern: string,
  path: string,
  glob?: string,
): string[] {
  if (useRg) {
    const a = ['--line-number', '--no-heading', '--color=never'];
    if (glob) a.push('--glob', glob);
    a.push('--', pattern, path);
    return a;
  }
  return ['-rn', '-E', '--', pattern, path];
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
      const args = buildGrepArgs(useRg, pattern, path, glob);

      const baseOpts = { reject: false as const, encoding: 'utf8' as const };
      const execOpts = opts?.signal ? { ...baseOpts, cancelSignal: opts.signal } : baseOpts;
      const result = await execa(cmd, args, execOpts);
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';

      if (result.exitCode === 0) {
        return ok(stdout.length > 30000 ? `${stdout.slice(0, 30000)}\n[truncated]` : stdout);
      }
      // Exit 1 with nothing on stderr is the shared "no matches" convention
      // for both rg and grep. The same code WITH stderr — or any other
      // non-zero code, such as a bad pattern or an unreadable path — is a
      // real failure and must never come back as a successful, empty
      // search: that used to surface the tool's own stderr as if it were a
      // clean result.
      if (result.exitCode === 1 && !stderr) {
        return ok('(no matches)');
      }
      return err(
        `Grep failed (exit ${String(result.exitCode)}): ${stderr || stdout || 'unknown error'}`,
      );
    } catch (e) {
      return err(`Grep failed: ${(e as Error).message}`);
    }
  },
};
