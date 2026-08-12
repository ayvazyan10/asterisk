// Bash tool — runs shell commands via execa with a 60s default timeout.
// Reference: https://github.com/sindresorhus/execa
//
// Commands pass a permission gate first (bash-gate.ts): read-only commands
// run straight through, anything else needs the user to approve it. See
// bash-permissions.ts for what that does and, importantly, does not promise.

import { execa } from 'execa';
import { authoriseBashCommand } from './bash-gate.ts';
import { checkBashSafety } from './bash-safety.ts';
import { type Tool, err, ok } from './types.ts';

export const bashTool: Tool = {
  name: 'Bash',
  // The permission gate can sit waiting on a person for up to 90s, which would
  // otherwise eat most of the loop's 120s deadline and leave a legitimate
  // command to be killed as if it had run away. Bash still bounds itself:
  // execa gets `timeout`, capped at 600s.
  interactive: true,
  description:
    'Run a shell command and return its combined stdout/stderr. Use for file listings, builds, tests, git, anything reasonable in a shell. Output is truncated at 30000 characters. Read-only commands run immediately; anything else asks the user to approve it first, so prefer one clear command over a long chain — a chain needs approval if any part of it does.',
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

    // Defence in depth, not the boundary. The denylist catches a handful of
    // obvious mistakes cheaply; `rm -r -f /` and `sh -c '…'` walk straight
    // through it, which is why the permission gate below exists.
    const safety = checkBashSafety(command);
    if (!safety.safe) {
      return err(`command blocked by safety check:\n${safety.warnings.join('\n')}`);
    }

    const gate = await authoriseBashCommand(command, opts?.signal);
    if (!gate.allowed) return err(gate.message);

    const rawTimeout = typeof input['timeoutSeconds'] === 'number' ? input['timeoutSeconds'] : 60;
    const timeoutMs = Math.min(Math.max(rawTimeout, 1), 600) * 1000;

    try {
      const result = await execa('bash', ['-lc', command], {
        timeout: timeoutMs,
        reject: false,
        all: true,
        encoding: 'utf8' as const,
        forceKillAfterDelay: 3000,
        ...(opts?.signal ? { cancelSignal: opts.signal } : {}),
      });
      if (result.isCanceled || result.isTerminated) {
        const reason = result.isCanceled ? 'cancelled' : `killed by ${result.signal}`;
        const partial = [result.stdout, result.stderr].filter((s) => s && s.length > 0).join('\n');
        return err(
          `command ${reason} after ${Math.round(timeoutMs / 1000)}s${partial ? `\n${partial.slice(0, 2000)}` : ''}`,
        );
      }
      const combined = [result.stdout, result.stderr].filter((s) => s && s.length > 0).join('\n');
      const truncated =
        combined.length > 30000
          ? `${combined.slice(0, 30000)}\n[truncated ${combined.length - 30000} chars]`
          : combined;
      const prefix = `exit=${result.exitCode}\n`;
      return ok(prefix + truncated);
    } catch (e) {
      return err(`Bash failed: ${(e as Error).message}`);
    }
  },
};
