// Applies the configured sandbox policy to a Bash invocation.
//
// The split mirrors the permission gate: sandbox.ts is the mechanism and knows
// nothing about configuration, this is the policy layer that reads the user's
// settings and decides what the mechanism is asked to do.

import { loadConfig } from '../config/load.ts';
import { defaultWritablePaths, sandboxStatus, wrapCommand } from './sandbox.ts';
import { workspaceRoot } from './workspace.ts';

export interface ConfinedCommand {
  allowed: boolean;
  /** Set when refused — `sandbox.mode: required` with no working backend. */
  message: string;
  file: string;
  args: string[];
  cleanup?: () => void;
}

/** Schema defaults, used when config or the database cannot be read. */
const FALLBACK = { mode: 'auto', network: true, writablePaths: [] as string[] } as const;

function resolveSettings(): { mode: string; network: boolean; writablePaths: string[] } {
  try {
    const { config } = loadConfig();
    const s = config.sandbox;
    return { mode: s.mode, network: s.network, writablePaths: [...s.writablePaths] };
  } catch {
    return { mode: FALLBACK.mode, network: FALLBACK.network, writablePaths: [] };
  }
}

/**
 * Returns the invocation to run, confined according to configuration.
 *
 * Never throws: a sandbox that errors while being set up must not take the
 * turn down with it. The one refusal is deliberate — `mode: required` exists
 * precisely so that a missing backend is an error rather than a silent
 * downgrade to running unconfined.
 */
export async function confineBashCommand(command: string): Promise<ConfinedCommand> {
  const unconfined: ConfinedCommand = {
    allowed: true,
    message: '',
    file: 'bash',
    args: ['-lc', command],
  };

  const settings = resolveSettings();
  if (settings.mode === 'off') return unconfined;

  try {
    const status = await sandboxStatus();

    if (status.backend === 'none') {
      if (settings.mode === 'required') {
        return {
          ...unconfined,
          allowed: false,
          message: [
            `refused: sandbox.mode is "required" but no sandbox is available — ${status.reason}.`,
            'Install bubblewrap (Linux) or run on macOS, or set sandbox.mode to "auto"',
            'to allow unconfined execution when no backend is present.',
          ].join(' '),
        };
      }
      return unconfined;
    }

    const wrapped = await wrapCommand(command, {
      // defaultWritablePaths() already folds in sandbox.writablePaths through
      // write-policy.ts, so adding settings.writablePaths again would list every
      // configured path twice in the bwrap argv.
      writablePaths: defaultWritablePaths(),
      network: settings.network,
      cwd: workspaceRoot(),
    });

    return {
      allowed: true,
      message: '',
      file: wrapped.file,
      args: wrapped.args,
      ...(wrapped.cleanup ? { cleanup: wrapped.cleanup } : {}),
    };
  } catch {
    // Failing to build the sandbox is not a reason to fail the command in
    // "auto" — but it is in "required", where the whole point is the guarantee.
    if (settings.mode === 'required') {
      return {
        ...unconfined,
        allowed: false,
        message: 'refused: sandbox.mode is "required" and the sandbox could not be set up.',
      };
    }
    return unconfined;
  }
}
