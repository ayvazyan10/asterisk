// Argument parsing and command body for `asterisk run` — one non-interactive
// agent turn against a prompt, in the caller's cwd, then exit.
//
// Kept out of the entrypoint so it is importable without a module-level
// main() firing, same split as src/eval/cli.ts: the entrypoint supplies argv
// and a real process, this module does the work and returns an exit code.

import { randomUUID } from 'node:crypto';

import type { AgentSession } from '../agent/context.ts';
import {
  type AgentTurnResult,
  type TerminalReason,
  createAgentState,
  runAgentTurn,
} from '../agent/loop.ts';
import { loadConfig } from '../config/load.ts';
import { closeDb, dbPath } from '../db/index.ts';
import { type McpManager, createMcpManager } from '../mcp/manager.ts';
import { chooseProvider } from '../providers/factory.ts';
import { loadRules } from '../rules/loader.ts';
import { loadSouls } from '../soul/loader.ts';
import { automaticDenialCount, clearAutomaticDenials } from '../tools/approval.ts';
import { setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';

export const USAGE = `asterisk run — one non-interactive agent turn

Usage:
  asterisk run [--allow-tools] "the prompt"
  echo "the prompt" | asterisk run [--allow-tools]

Runs a single agent turn against the given prompt, in the current working
directory, and exits. Built for another program to spawn: one prompt in, one
reply out, no REPL, no daemon, nothing added to the stored conversation
history.

Flags:
  --allow-tools   Treat permissions as 'allow' for this run only — a tool
                  call that would otherwise refuse for lack of an approver
                  runs instead. Nothing in the stored config changes; the
                  REPL, the daemon and the bot transports are unaffected.
                  Without this flag the run follows permissions.headless
                  from config (default: deny), and such a call is refused.
  -h, --help      Show this help

The prompt is the positional argument (quote it if it has spaces; several
positional words are joined with a single space). With no argument, the
prompt is read from stdin — so a bare "asterisk run" at an interactive
terminal is a usage error, not a hang waiting for input that isn't coming.

Exit codes:
  0   the turn completed
  1   bad invocation — no prompt, or an unrecognised flag
  2   could not start — config or provider could not be constructed
  3   a tool needed approval and nothing could grant it (pass --allow-tools)
  4   hit the turn limit before finishing
  5   the run was aborted
  6   the conversation would not fit the model's context window
  7   the provider rejected the request as unauthenticated
  8   the provider rejected the request as malformed
  9   an unexpected error`;

/** Distinct per cause on purpose — a caller spawning `asterisk run` as a
 *  worker can branch on the code without scraping stderr text. */
export const EXIT_CODES = {
  OK: 0,
  USAGE: 1,
  STARTUP: 2,
  PERMISSION_REFUSED: 3,
  MAX_TURNS: 4,
  ABORTED: 5,
  CONTEXT_OVERFLOW: 6,
  AUTH_ERROR: 7,
  BAD_REQUEST: 8,
  UNKNOWN_ERROR: 9,
} as const;

export interface RunFlags {
  allowTools: boolean;
  help: boolean;
  /** Positional words joined with a single space. Undefined — not empty —
   *  when none were given, so the caller knows to fall back to stdin. */
  prompt?: string;
}

export function parseArgs(argv: readonly string[]): RunFlags {
  let allowTools = false;
  let help = false;
  const words: string[] = [];
  for (const arg of argv) {
    if (arg === '--allow-tools') {
      allowTools = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      words.push(arg);
    }
  }
  const prompt = words.length > 0 ? words.join(' ') : undefined;
  return { allowTools, help, ...(prompt !== undefined ? { prompt } : {}) };
}

export interface CliStreams {
  out(text: string): void;
  err(text: string): void;
}

const PROCESS_STREAMS: CliStreams = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * Everything this command needs that would otherwise reach the network, the
 * filesystem, or a live terminal — injectable so tests exercise real parsing
 * and exit-code logic without contacting a model or blocking on stdin.
 */
export interface RunCliDeps {
  /** Builds the Provider this run talks to. Defaults to the same
   *  config-driven choice the REPL and daemon make (chooseProvider, with the
   *  same ASTERISK_PROVIDER one-run override cli.tsx honours). */
  createProvider(): Provider;
  /** Defaults to the real MCP manager. A run with no configured MCP servers
   *  — the common case, and every test's isolated ASTERISK_HOME — reloads
   *  against an empty list and returns immediately either way. */
  createMcpManager(): McpManager;
  /** Reads the prompt from stdin when no positional argument was given.
   *  Resolves null when stdin is a TTY: nothing was piped in, and reading
   *  from a live terminal here would hang waiting for input that was never
   *  coming — exactly what this subcommand must never do. */
  readStdinPrompt(): Promise<string | null>;
}

function defaultCreateProvider(): Provider {
  const loaded = loadConfig();
  // Same one-run override cli.tsx supports for the REPL, honoured here for
  // the same reason: a caller scripting `asterisk run` wants it without
  // touching the stored config either.
  const explicit = (process.env['ASTERISK_PROVIDER'] ?? '').toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai-compatible') {
    loaded.config = { ...loaded.config, provider: explicit };
  }
  const chosen = chooseProvider(loaded);
  if (chosen.fallbackReason) {
    process.stderr.write(`asterisk run: ${chosen.fallbackReason} — using ${chosen.kind}\n`);
  }
  return chosen.provider;
}

async function defaultReadStdinPrompt(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const PROCESS_DEPS: RunCliDeps = {
  createProvider: defaultCreateProvider,
  createMcpManager,
  readStdinPrompt: defaultReadStdinPrompt,
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The most identifying field of a tool call, for a one-line stderr status —
 *  same idea as daemon.ts's formatToolStatus, kept small and local here
 *  rather than shared, since the two diagnostic lines don't need to match. */
function summariseInput(input: Record<string, unknown>): string {
  const arg =
    (typeof input['command'] === 'string' && input['command']) ||
    (typeof input['path'] === 'string' && input['path']) ||
    (typeof input['url'] === 'string' && input['url']) ||
    (typeof input['query'] === 'string' && input['query']) ||
    (typeof input['prompt'] === 'string' && input['prompt']) ||
    '';
  return arg.length > 100 ? `${arg.slice(0, 100)}…` : arg;
}

/**
 * How many *consecutive* automatic permission denials end the run early
 * instead of waiting for the model to notice on its own.
 *
 * One denial is normal — a model guesses a command, gets told no, and picks
 * a legal one next; that is exploring, not stuck. Two in a row already means
 * it is guessing at the policy rather than working around it. By three there
 * is no ambiguity left: nothing between here and the turn cap is going to get
 * past the same wall, and letting it keep trying just burns the run down to
 * an external timeout instead of this command's own clean refusal. (Observed
 * directly: an unattended run with no approver tried echo/printf/`bash -c`/
 * touch/`sort -o`/`curl -o`/a data: URL, then started reading this project's
 * own permission source and grepping the database for a way around it —
 * thirty-odd attempts before something outside this process finally killed
 * it.) Any *allowed* call in between resets the streak — see the tracking
 * below.
 */
export const MAX_CONSECUTIVE_AUTO_DENIALS = 3;

function exitCodeForReason(reason: TerminalReason): number {
  switch (reason) {
    case 'end-turn':
      return EXIT_CODES.OK;
    case 'max-turns':
      return EXIT_CODES.MAX_TURNS;
    case 'aborted':
      return EXIT_CODES.ABORTED;
    case 'context-overflow':
      return EXIT_CODES.CONTEXT_OVERFLOW;
    case 'auth-error':
      return EXIT_CODES.AUTH_ERROR;
    case 'bad-request':
      return EXIT_CODES.BAD_REQUEST;
    case 'unknown-error':
      return EXIT_CODES.UNKNOWN_ERROR;
    default:
      // Defensive: TerminalReason may grow a case this function hasn't been
      // taught about yet. Falling to the catch-all is safer than a compile
      // error nobody notices until the next release.
      return EXIT_CODES.UNKNOWN_ERROR;
  }
}

/** Runs the command and returns the intended process exit code. See EXIT_CODES
 *  for what each one means. */
export async function runRunCli(
  argv: readonly string[],
  streams: CliStreams = PROCESS_STREAMS,
  deps: RunCliDeps = PROCESS_DEPS,
): Promise<number> {
  let flags: RunFlags;
  try {
    flags = parseArgs(argv);
  } catch (error) {
    streams.err(`asterisk run: ${describeError(error)}\n\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }

  if (flags.help) {
    streams.out(`${USAGE}\n`);
    return EXIT_CODES.OK;
  }

  let prompt = flags.prompt?.trim();
  if (!prompt) {
    const piped = await deps.readStdinPrompt();
    prompt = piped?.trim() || undefined;
  }
  if (!prompt) {
    streams.err(
      `asterisk run: no prompt given — pass one as an argument or pipe it on stdin.\n\n${USAGE}\n`,
    );
    return EXIT_CODES.USAGE;
  }

  let provider: Provider;
  let mcp: McpManager;
  try {
    provider = deps.createProvider();
    mcp = deps.createMcpManager();
  } catch (error) {
    streams.err(`asterisk run: could not start — ${describeError(error)}\n`);
    return EXIT_CODES.STARTUP;
  }

  const session: AgentSession = {
    id: `run:${randomUUID()}`,
    // Same unattended shape as the daemon scheduler's `scheduled:<source>`
    // sessions: nobody can answer an approval prompt in either case, which
    // is exactly the scenario permissions.headless exists for.
    scope: 'scheduled',
    ...(flags.allowTools ? { headlessOverride: 'allow' as const } : {}),
  };

  try {
    const mcpResult = await mcp.reload();
    setExtraTools(mcp.tools);
    for (const failure of mcpResult.failed) {
      streams.err(`asterisk run: mcp server "${failure.name}" failed: ${failure.error}\n`);
    }

    const state = createAgentState();
    const rules = loadRules();
    const souls = loadSouls(process.cwd(), session);
    const hooks = loadConfig().config.hooks;

    // Consecutive-automatic-denial tracking, checked after every tool result.
    // `automaticDenialCount` is cumulative for the session, so the streak is
    // this callback's own delta against the last value it saw: a call that
    // didn't move the counter — allowed, or failed for some other reason —
    // resets it, and only an unbroken run of denials closes in on the limit.
    // See MAX_CONSECUTIVE_AUTO_DENIALS for why three.
    const ctrl = new AbortController();
    let lastAutoDenialCount = automaticDenialCount(session.id);
    let consecutiveAutoDenials = 0;

    let result: AgentTurnResult;
    try {
      result = await runAgentTurn(provider, state, prompt, {
        session,
        rules,
        souls,
        hooks,
        signal: ctrl.signal,
        onToolUse: (name, input) => {
          const arg = summariseInput(input);
          streams.err(arg ? `→ ${name} ${arg}\n` : `→ ${name}\n`);
        },
        onToolResult: (name, output, isError) => {
          const firstLine = (output.split('\n')[0] ?? '').trim();
          const trimmed = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
          streams.err(`${isError ? '✗' : '✓'} ${name}${trimmed ? `: ${trimmed}` : ''}\n`);

          const denialsNow = automaticDenialCount(session.id);
          consecutiveAutoDenials =
            denialsNow > lastAutoDenialCount ? consecutiveAutoDenials + 1 : 0;
          lastAutoDenialCount = denialsNow;
          if (consecutiveAutoDenials >= MAX_CONSECUTIVE_AUTO_DENIALS && !ctrl.signal.aborted) {
            streams.err(
              `asterisk run: ${MAX_CONSECUTIVE_AUTO_DENIALS} tool calls in a row were refused for lack of an approver — stopping instead of letting the model keep trying.\n`,
            );
            ctrl.abort(
              new Error(
                `stopped after ${MAX_CONSECUTIVE_AUTO_DENIALS} consecutive automatic permission denials`,
              ),
            );
          }
        },
        onRetry: (attempt, delayMs, reason) => {
          streams.err(`… retry ${attempt} in ${delayMs}ms: ${reason}\n`);
        },
      });
    } catch (error) {
      streams.err(`asterisk run: turn failed — ${describeError(error)}\n`);
      return EXIT_CODES.UNKNOWN_ERROR;
    }

    // Printed even when a permission refusal follows below: the model's own
    // account of what happened is still useful to a caller reading stdout.
    streams.out(`${result.finalText}\n`);

    if (automaticDenialCount(session.id) > 0) {
      streams.err(
        'asterisk run: a tool call needed approval and nothing could grant it — this is an ' +
          'unattended run. Pass --allow-tools to allow tool calls for this run, or set ' +
          'permissions.allow / permissions.headless in the stored config.\n',
      );
      return EXIT_CODES.PERMISSION_REFUSED;
    }

    return exitCodeForReason(result.reason);
  } finally {
    clearAutomaticDenials(session.id);
    await mcp.shutdown().catch(() => {});
    // A caller running many of these in a row should not accumulate an open
    // WAL connection per invocation; see db/index.ts's own closeDb comment.
    // Scoped to this run's own database path, not every cached connection —
    // a host process that calls runRunCli more than once (tests do) must not
    // have one invocation close a connection a different ASTERISK_HOME still
    // owns.
    closeDb(dbPath());
  }
}
