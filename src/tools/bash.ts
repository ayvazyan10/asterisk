// Bash tool — runs shell commands via execa with a 60s default timeout.
// Reference: https://github.com/sindresorhus/execa

import { execa } from 'execa';
import { type Tool, ok, err } from './types.ts';

export const bashTool: Tool = {
  name: 'Bash',
  description:
    'Run a shell command and return its combined stdout/stderr. Use for file listings, builds, tests, git, anything reasonable in a shell. Output is truncated at 30000 characters.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeoutSeconds: {
        type: 'number',
        description: 'Optional timeout in seconds (default 60, max 600).',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    if (!command) return err('command is required');

    const rawTimeout =
      typeof input['timeoutSeconds'] === 'number' ? input['timeoutSeconds'] : 60;
    const timeoutMs = Math.min(Math.max(rawTimeout, 1), 600) * 1000;

    try {
      const baseOpts = {
        timeout: timeoutMs,
        reject: false as const,
        all: true,
        encoding: 'utf8' as const,
      };
      const execOpts = opts?.signal
        ? { ...baseOpts, cancelSignal: opts.signal }
        : baseOpts;
      const { stdout, stderr, exitCode } = await execa('bash', ['-lc', command], execOpts);
      const combined = [stdout, stderr].filter((s) => s && s.length > 0).join('\n');
      const truncated =
        combined.length > 30000
          ? `${combined.slice(0, 30000)}\n[truncated ${combined.length - 30000} chars]`
          : combined;
      const prefix = `exit=${exitCode}\n`;
      return ok(prefix + truncated);
    } catch (e) {
      return err(`Bash failed: ${(e as Error).message}`);
    }
  },
};
