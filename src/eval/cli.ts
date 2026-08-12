// Argument parsing and command body for `asterisk eval`.
//
// Kept out of the entrypoint so it is importable without a module-level main()
// firing — the entrypoint is a shim that supplies argv and turns the returned
// code into a process exit.

import { loadConfig } from '../config/load.ts';
import { createProviderChain } from '../providers/factory.ts';
import type { Provider } from '../types/messages.ts';
import { formatScenarioList, formatSuite, suiteToJson } from './report.ts';
import { type RunSuiteOptions, runSuite, selectScenarios } from './runner.ts';
import { SCENARIOS } from './scenarios/index.ts';
import type { Scenario } from './types.ts';

export const USAGE = `asterisk eval — run the scenario suite

Usage:
  asterisk eval [flags] [name-filter ...]

Flags:
  --list            List scenarios and exit
  --live            Run against the configured provider (contacts a model)
  --grade           Also answer model-graded criteria (contacts a model)
  --json            Emit machine-readable results instead of a report
  --keep            Leave fixture workspaces on disk for inspection
  --timeout <s>     Per-scenario deadline (default 120)
  -h, --help        Show this help

Name filters are case-insensitive substrings; with none, every scenario runs.
Without --live no model is contacted: scenarios replay their scripted
responses, which exercises the loop, the tools and the criteria.
Exit code is 0 only when every selected scenario passes.`;

export interface EvalFlags {
  list: boolean;
  live: boolean;
  grade: boolean;
  json: boolean;
  keep: boolean;
  help: boolean;
  timeoutMs?: number;
  filters: string[];
}

const BOOLEAN_FLAGS: Record<string, keyof EvalFlags> = {
  '--list': 'list',
  '--live': 'live',
  '--grade': 'grade',
  '--json': 'json',
  '--keep': 'keep',
  '--help': 'help',
  '-h': 'help',
};

export function parseArgs(argv: readonly string[]): EvalFlags {
  const flags: EvalFlags = {
    list: false,
    live: false,
    grade: false,
    json: false,
    keep: false,
    help: false,
    filters: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const boolKey = BOOLEAN_FLAGS[arg];
    if (boolKey) {
      // Only the boolean members are ever addressed this way, but TypeScript
      // cannot see that through the lookup table, hence the narrow cast.
      (flags as unknown as Record<string, boolean>)[boolKey] = true;
    } else if (arg === '--timeout') {
      const raw = argv[i + 1];
      const seconds = Number(raw);
      if (!raw || !Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`--timeout expects a positive number of seconds, got "${raw ?? ''}"`);
      }
      flags.timeoutMs = seconds * 1000;
      i++;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (arg) {
      flags.filters.push(arg);
    }
  }
  return flags;
}

export interface CliStreams {
  out(text: string): void;
  err(text: string): void;
}

const PROCESS_STREAMS: CliStreams = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Runs the command and returns the intended exit code. 0 = every selected
 *  scenario passed, 1 = something failed or errored, 2 = the invocation itself
 *  was wrong (bad flag, no scenario matched). */
export async function runEvalCli(
  argv: readonly string[],
  streams: CliStreams = PROCESS_STREAMS,
  scenarios: readonly Scenario[] = SCENARIOS,
): Promise<number> {
  let flags: EvalFlags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    streams.err(`${describe(error)}\n\n${USAGE}\n`);
    return 2;
  }

  if (flags.help) {
    streams.out(`${USAGE}\n`);
    return 0;
  }

  const selected = selectScenarios(scenarios, flags.filters);
  if (flags.list) {
    streams.out(`${formatScenarioList(selected)}\n`);
    return 0;
  }
  if (selected.length === 0) {
    streams.err(`no scenario matched: ${flags.filters.join(', ')}\n`);
    return 2;
  }

  const suite = await runSuite(selected, buildOptions(flags, streams));
  streams.out(`${flags.json ? suiteToJson(suite) : formatSuite(suite)}\n`);
  return suite.failed + suite.errored === 0 ? 0 : 1;
}

function buildOptions(flags: EvalFlags, streams: CliStreams): RunSuiteOptions {
  // One provider serves both roles when both are asked for; grading with a
  // second configured backend is a refinement nobody has needed yet.
  const model: Provider | undefined =
    flags.live || flags.grade ? createProviderChain(loadConfig()).provider : undefined;
  return {
    keepWorkspace: flags.keep,
    ...(flags.live && model ? { provider: model } : {}),
    ...(flags.grade && model ? { grader: model } : {}),
    ...(flags.timeoutMs !== undefined ? { timeoutMs: flags.timeoutMs } : {}),
    // Progress on stderr as each scenario lands: a live suite can sit on one
    // scenario for a minute, and silence there reads as a hang. Suppressed for
    // --json so the stream a script parses stays clean.
    ...(flags.json ? {} : { onResult: (r) => streams.err(`  ${r.status.padEnd(5)} ${r.name}\n`) }),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
