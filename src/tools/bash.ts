// Bash tool — runs shell commands via execa with a 60s default timeout.
// Reference: https://github.com/sindresorhus/execa
//
// Commands pass a permission gate first (bash-gate.ts): read-only commands
// run straight through, anything else needs the user to approve it. See
// bash-permissions.ts for what that does and, importantly, does not promise.

import { execa } from 'execa';
import { authoriseBashCommand } from './bash-gate.ts';
import { checkBashSafety } from './bash-safety.ts';
import { confineBashCommand } from './bash-sandbox.ts';
import { type Tool, err, ok } from './types.ts';

/** How long to keep waiting for a killed child before abandoning it. */
const ABORT_GRACE_MS = 400;

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

    // Approval decided that the command may run; the sandbox decides what it
    // can reach while running. Both apply — an approved command is still
    // confined.
    const confined = await confineBashCommand(command);
    if (!confined.allowed) return err(confined.message);

    // Do not spawn anything for a turn that has already been abandoned. The
    // gate and the sandbox setup both await, so the signal can fire between
    // entering this function and reaching execa — and execa does not reliably
    // kill a process whose cancelSignal was already aborted when it was
    // handed over, which showed up as a cancelled turn still waiting out a
    // full `sleep 10`.
    if (opts?.signal?.aborted) {
      confined.cleanup?.();
      return err('command cancelled before it started');
    }

    // Cancellation is best-effort by necessity, and then bounded.
    //
    // Signalling a sandbox launcher that was spawned microseconds ago does not
    // reliably kill it: bubblewrap has not finished setting up its namespaces,
    // the signal is lost, and the command keeps running with the output pipe
    // open — so awaiting the child means a cancelled turn sits through the
    // whole `sleep 10`. Observed with a 2ms gap between spawn and abort; a
    // second SIGKILL 150ms later does not close it either.
    //
    // So: kill twice, then stop waiting. The caller asked for this turn to end
    // and is owed a prompt answer more than it is owed a reaped child.
    //
    // The cost is real and worth stating: when both kills are lost, the command
    // keeps running, and because it is no longer bubblewrap's child
    // `--die-with-parent` does not reach it either — it is reparented to init
    // and outlives the agent. Rare, and preferable to hanging the turn, but it
    // is a leak rather than a clean cancellation, which is why the message says
    // "abandoned" instead of "cancelled".
    let killChild: ((signal: 'SIGTERM' | 'SIGKILL') => void) | undefined;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let giveUp: (() => void) | undefined;

    const killOnAbort = (): void => {
      killChild?.('SIGTERM');
      timers.push(setTimeout(() => killChild?.('SIGKILL'), 150));
      timers.push(setTimeout(() => giveUp?.(), ABORT_GRACE_MS));
    };
    opts?.signal?.addEventListener('abort', killOnAbort, { once: true });

    try {
      const child = execa(confined.file, confined.args, {
        timeout: timeoutMs,
        reject: false,
        all: true,
        encoding: 'utf8' as const,
        forceKillAfterDelay: 3000,
        ...(opts?.signal ? { cancelSignal: opts.signal } : {}),
      });
      killChild = (signal) => {
        child.kill(signal);
      };
      // Covers the signal firing between the check above and the subprocess
      // existing to be killed.
      if (opts?.signal?.aborted) killOnAbort();

      const abandoned = new Promise<'abandoned'>((resolve) => {
        giveUp = () => resolve('abandoned');
      });
      const outcome = await Promise.race([child, abandoned]);
      if (outcome === 'abandoned') {
        return err('command cancelled; the process did not exit and was abandoned');
      }
      const result = outcome;
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
    } finally {
      for (const t of timers) clearTimeout(t);
      opts?.signal?.removeEventListener('abort', killOnAbort);
      confined.cleanup?.();
    }
  },
};
