// `asterisk run` — argument parsing, the permission gate with and without
// --allow-tools, and the exit-code mapping from a turn's TerminalReason.
//
// Provider and MCP manager are always injected (RunCliDeps) so nothing here
// contacts a real model or a real MCP server. Config is still real — an
// isolated ASTERISK_HOME per test, same pattern as tests/bash-gate.test.ts —
// because the permission tests need the actual bash-gate.ts / approval.ts
// machinery, not a stand-in for it.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb } from '../src/db/index.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import {
  EXIT_CODES,
  MAX_CONSECUTIVE_AUTO_DENIALS,
  type RunCliDeps,
  type RunFlags,
  USAGE,
  parseArgs,
  runRunCli,
} from '../src/run/cli.ts';
import { _resetApprovalsForTesting } from '../src/tools/approval.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'asterisk-run-cli-'));
  prevHome = process.env['ASTERISK_HOME'];
  process.env['ASTERISK_HOME'] = home;
});

afterEach(async () => {
  _resetApprovalsForTesting();
  closeDb();
  if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
  else process.env['ASTERISK_HOME'] = prevHome;
  await rm(home, { recursive: true, force: true });
});

// --- test doubles -----------------------------------------------------

function textReply(text: string): ProviderResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

/** Scripted provider: returns each response in order, records every request
 *  it was sent so a test can inspect what the model actually saw. */
function scriptedProvider(responses: ProviderResponse[]): Provider & { requests: unknown[] } {
  let i = 0;
  const requests: unknown[] = [];
  return {
    name: 'fake',
    requests,
    async send(req) {
      requests.push(req);
      const r = responses[i++];
      if (!r) throw new Error('scriptedProvider exhausted');
      return r;
    },
  };
}

function throwingProvider(message: string): Provider {
  return {
    name: 'fake-throwing',
    async send() {
      throw new Error(message);
    },
  };
}

/** Returns a tool_use for the same unknown tool forever, with a different
 *  argument each time so the identical-call cap never kicks in. Used to
 *  force max-turns without spawning any real tool (Bash included). */
function neverEndingProvider(): Provider {
  let i = 0;
  return {
    name: 'fake-looping',
    async send() {
      i += 1;
      return {
        content: [{ type: 'tool_use', id: `t${i}`, name: 'NoSuchTool', input: { n: i } }],
        stopReason: 'tool_use',
      };
    },
  };
}

function stubMcpManager(): McpManager {
  return {
    servers: [],
    tools: [],
    async reload() {
      return { connected: [], failed: [] };
    },
    async shutdown() {},
  };
}

function baseDeps(overrides: Partial<RunCliDeps> = {}): RunCliDeps {
  return {
    createProvider: () => scriptedProvider([textReply('ok')]),
    createMcpManager: stubMcpManager,
    readStdinPrompt: async () => null,
    ...overrides,
  };
}

function captureStreams(): {
  out: string[];
  err: string[];
  streams: { out: (t: string) => void; err: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, streams: { out: (t) => out.push(t), err: (t) => err.push(t) } };
}

// --- parseArgs ----------------------------------------------------------

describe('parseArgs', () => {
  it('returns no prompt when called with nothing', () => {
    const flags = parseArgs([]);
    expect(flags).toEqual<RunFlags>({ allowTools: false, help: false });
  });

  it('joins positional words into one prompt', () => {
    expect(parseArgs(['do', 'the', 'thing']).prompt).toBe('do the thing');
  });

  it('accepts --allow-tools before the prompt', () => {
    const flags = parseArgs(['--allow-tools', 'hello world']);
    expect(flags.allowTools).toBe(true);
    expect(flags.prompt).toBe('hello world');
  });

  it('accepts --allow-tools after the prompt', () => {
    const flags = parseArgs(['hello world', '--allow-tools']);
    expect(flags.allowTools).toBe(true);
    expect(flags.prompt).toBe('hello world');
  });

  it('recognises -h and --help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('throws on an unrecognised flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag: --bogus/);
  });
});

// --- invocation-level behaviour ------------------------------------------

describe('runRunCli — invocation', () => {
  it('exits USAGE with no prompt and nothing on stdin', async () => {
    const { streams, err } = captureStreams();
    const code = await runRunCli([], streams, baseDeps());
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(err.join('')).toContain('no prompt given');
  });

  it('rejects an unrecognised flag before touching provider or stdin', async () => {
    const { streams, err } = captureStreams();
    const deps = baseDeps({
      createProvider: () => {
        throw new Error('should not be called');
      },
    });
    const code = await runRunCli(['--nope'], streams, deps);
    expect(code).toBe(EXIT_CODES.USAGE);
    expect(err.join('')).toContain('unknown flag: --nope');
  });

  it('reads the prompt from stdin when no argument is given', async () => {
    const provider = scriptedProvider([textReply('done')]);
    const { streams, out } = captureStreams();
    const deps = baseDeps({
      createProvider: () => provider,
      readStdinPrompt: async () => 'hello from stdin',
    });

    const code = await runRunCli([], streams, deps);

    expect(code).toBe(EXIT_CODES.OK);
    expect(out.join('')).toBe('done\n');
    const firstRequest = provider.requests[0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(firstRequest.messages[0]?.content)).toContain('hello from stdin');
  });

  it('never reads stdin when a positional prompt was given', async () => {
    let stdinCalled = false;
    const deps = baseDeps({
      readStdinPrompt: async () => {
        stdinCalled = true;
        return null;
      },
    });
    const { streams } = captureStreams();

    await runRunCli(['do the thing'], streams, deps);

    expect(stdinCalled).toBe(false);
  });

  it('prints help and exits OK without constructing a provider', async () => {
    const { streams, out } = captureStreams();
    const deps = baseDeps({
      createProvider: () => {
        throw new Error('should not be called');
      },
    });

    const code = await runRunCli(['--help'], streams, deps);

    expect(code).toBe(EXIT_CODES.OK);
    expect(out.join('')).toContain('asterisk run');
  });

  it('exits STARTUP when the provider cannot be constructed', async () => {
    const { streams, err } = captureStreams();
    const deps = baseDeps({
      createProvider: () => {
        throw new Error('no model configured');
      },
    });

    const code = await runRunCli(['hi'], streams, deps);

    expect(code).toBe(EXIT_CODES.STARTUP);
    expect(err.join('')).toContain('no model configured');
  });

  it('prints only the final text to stdout', async () => {
    const deps = baseDeps({ createProvider: () => scriptedProvider([textReply('the answer')]) });
    const { streams, out } = captureStreams();

    const code = await runRunCli(['question'], streams, deps);

    expect(code).toBe(EXIT_CODES.OK);
    expect(out).toEqual(['the answer\n']);
  });
});

// --- exit codes from the turn's TerminalReason ---------------------------

describe('runRunCli — turn outcomes', () => {
  it('exits UNKNOWN_ERROR when the turn throws', async () => {
    const deps = baseDeps({ createProvider: () => throwingProvider('provider exploded') });
    const { streams, err } = captureStreams();

    const code = await runRunCli(['hi'], streams, deps);

    expect(code).toBe(EXIT_CODES.UNKNOWN_ERROR);
    expect(err.join('')).toContain('provider exploded');
  });

  it('exits MAX_TURNS when the model never stops calling tools', async () => {
    const deps = baseDeps({ createProvider: neverEndingProvider });
    const { streams } = captureStreams();

    const code = await runRunCli(['keep going'], streams, deps);

    expect(code).toBe(EXIT_CODES.MAX_TURNS);
  }, 20_000);
});

// --- the permission gate, with and without --allow-tools ------------------

describe('runRunCli — permission gate', () => {
  /** Provider that asks the model's Bash tool to create a marker file, then
   *  (regardless of whether that succeeded) sends a closing reply. */
  function bashOnceProvider(command: string): Provider {
    let step = 0;
    return {
      name: 'fake-bash',
      async send() {
        step += 1;
        if (step === 1) {
          return {
            content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command } }],
            stopReason: 'tool_use',
          };
        }
        return textReply('finished');
      },
    };
  }

  it('refuses an unattended tool call without --allow-tools, and never runs it', async () => {
    const marker = join(home, 'marker-denied');
    const deps = baseDeps({ createProvider: () => bashOnceProvider(`touch ${marker}`) });
    const { streams, err } = captureStreams();

    const code = await runRunCli(['make the file'], streams, deps);

    expect(code).toBe(EXIT_CODES.PERMISSION_REFUSED);
    expect(err.join('')).toContain('nothing could grant it');
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('runs the tool call with --allow-tools, unattended', async () => {
    const marker = join(home, 'marker-allowed');
    const deps = baseDeps({ createProvider: () => bashOnceProvider(`touch ${marker}`) });
    const { streams, out } = captureStreams();

    const code = await runRunCli(['--allow-tools', 'make the file'], streams, deps);

    expect(code).toBe(EXIT_CODES.OK);
    expect(out.join('')).toBe('finished\n');
    await expect(readFile(marker)).resolves.toBeDefined();
  });

  /** Always asks Bash to run the next command in `commands`, forever if the
   *  list runs short — never returns end_turn text on its own. Scripted with
   *  more commands than the consecutive-denial limit so the assertion that
   *  matters is "the run stopped itself", not "the script ran out". */
  function alwaysDeniedProvider(commands: readonly string[]): Provider & { requests: unknown[] } {
    let i = 0;
    const requests: unknown[] = [];
    return {
      name: 'fake-always-denied',
      requests,
      async send(req) {
        requests.push(req);
        const command = commands[Math.min(i, commands.length - 1)];
        i += 1;
        return {
          content: [{ type: 'tool_use', id: `d${i}`, name: 'Bash', input: { command } }],
          stopReason: 'tool_use',
        };
      },
    };
  }

  it(`stops after exactly ${MAX_CONSECUTIVE_AUTO_DENIALS} consecutive automatic denials, never attempting one more`, async () => {
    // One more command than the limit, all off-allowlist and all denied —
    // if the loop attempted an (N+1)th call, the provider could still answer
    // it, so `requests.length` staying at N is the actual proof it stopped
    // itself rather than merely running out of script.
    const commands = Array.from(
      { length: MAX_CONSECUTIVE_AUTO_DENIALS + 1 },
      (_, i) => `touch ${join(home, `marker-consecutive-${i}`)}`,
    );
    const provider = alwaysDeniedProvider(commands);
    const deps = baseDeps({ createProvider: () => provider });
    const { streams, err } = captureStreams();

    const code = await runRunCli(['keep trying every way you can think of'], streams, deps);

    expect(code).toBe(EXIT_CODES.PERMISSION_REFUSED);
    expect(provider.requests.length).toBe(MAX_CONSECUTIVE_AUTO_DENIALS);
    expect(err.join('')).toContain(
      `${MAX_CONSECUTIVE_AUTO_DENIALS} tool calls in a row were refused`,
    );
    // The original, detailed refusal message must still be there too — this
    // fix adds an early notice, it does not replace the existing one.
    expect(err.join('')).toContain('nothing could grant it');
    expect(err.join('')).toContain('permissions.allow / permissions.headless');
    for (const command of commands) {
      const marker = command.replace('touch ', '');
      await expect(readFile(marker)).rejects.toThrow();
    }
  });

  /** step 1: denied · step 2: allowed (resets the streak) · step 3: denied ·
   *  step 4: a closing reply — never reached if the streak-of-two survived
   *  the allowed call in between. */
  function deniedAllowedDeniedProvider(
    denied1: string,
    allowed: string,
    denied2: string,
  ): Provider & { requests: unknown[] } {
    let step = 0;
    const requests: unknown[] = [];
    return {
      name: 'fake-mixed',
      requests,
      async send(req) {
        requests.push(req);
        step += 1;
        const command = step === 1 ? denied1 : step === 2 ? allowed : denied2;
        if (step <= 3) {
          return {
            content: [{ type: 'tool_use', id: `m${step}`, name: 'Bash', input: { command } }],
            stopReason: 'tool_use',
          };
        }
        return textReply('done after mixed results');
      },
    };
  }

  it('does not stop early when an allowed call breaks up the streak', async () => {
    const denied1 = `touch ${join(home, 'marker-mixed-a')}`;
    const denied2 = `touch ${join(home, 'marker-mixed-b')}`;
    // `echo` is on the built-in read-only allowlist — it never reaches
    // requestApproval at all, so it cannot itself be an automatic denial.
    const provider = deniedAllowedDeniedProvider(denied1, 'echo still-here', denied2);
    const deps = baseDeps({ createProvider: () => provider });
    const { streams, out } = captureStreams();

    const code = await runRunCli(['keep trying, mixing it up'], streams, deps);

    // All four turns ran: two isolated denials, one call apart, never reach
    // MAX_CONSECUTIVE_AUTO_DENIALS, so the model was left to finish the turn
    // on its own rather than being cut off.
    expect(provider.requests.length).toBe(4);
    expect(out.join('')).toBe('done after mixed results\n');
    // The run still reports a refusal overall — two denials did happen, and
    // that end-of-run check is unchanged by this fix — but it got there by
    // the turn actually finishing, not by an early abort.
    expect(code).toBe(EXIT_CODES.PERMISSION_REFUSED);
  });
});

// --- help text mentions the new subcommand --------------------------------

describe('USAGE', () => {
  it('documents --allow-tools and the exit codes', () => {
    expect(USAGE).toContain('--allow-tools');
    expect(USAGE).toContain('asterisk run');
  });
});

describe('bin/asterisk help text', () => {
  it('lists the run subcommand', async () => {
    const script = await readFile(new URL('../bin/asterisk', import.meta.url), 'utf8');
    expect(script).toMatch(/\basterisk run\b/);
    expect(script).toMatch(/^\s*run\)\s*$/m);
  });
});
