// Shared scaffolding for the slash-command tests. Not a test file — vitest
// only collects *.test.ts.
//
// Every command module reads config and the SQLite database through
// ASTERISK_HOME, so each test gets its own temp home and its own database.
// `withTempHome()` wires the beforeEach/afterEach pair and hands back a getter
// for the current root.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { createAgentState } from '../src/agent/loop.ts';
import { COMMANDS, type CommandContext, type CommandResult } from '../src/commands/registry.ts';
import { closeDb } from '../src/db/index.ts';
import type { ConnectedMcpServer } from '../src/mcp/client.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { createOllamaProvider } from '../src/providers/ollama.ts';
import type { FormSpec, ListSpec } from '../src/repl/forms/types.ts';
import type { Tool } from '../src/tools/types.ts';
import type { Provider } from '../src/types/messages.ts';

/** Env vars that would otherwise leak the developer's real credentials into a
 *  test, since secret precedence is env > database. */
const ISOLATED_ENV = [
  'ASTERISK_HOME',
  'ANTHROPIC_API_KEY',
  'ASTERISK_OPENAI_API_KEY',
  'ASTERISK_TELEGRAM_BOT_TOKEN',
  'ASTERISK_WHATSAPP_META_TOKEN',
  'ASTERISK_WHATSAPP_VERIFY_TOKEN',
  'ASTERISK_INSTALL_DIR',
  'ASTERISK_BRANCH',
  'ASTERISK_LANG',
] as const;

/**
 * Points ASTERISK_HOME at a fresh temp dir for the duration of each test in
 * the calling `describe`, and closes the per-path database handle afterwards
 * so the WAL sidecars do not outlive the directory.
 */
export function withTempHome(prefix: string): () => string {
  let home = '';
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of ISOLATED_ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), `asterisk-${prefix}-`));
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    closeDb();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    await rm(home, { recursive: true, force: true });
  });

  return () => home;
}

export interface McpReloadResult {
  connected: string[];
  failed: { name: string; error: string }[];
}

export interface FakeMcp extends McpManager {
  /** How many times `/mcp` asked the manager to reconnect. */
  reloads: number;
  /** Canned answer for the next and every subsequent reload. */
  nextReload: McpReloadResult;
}

/** An McpManager that records reloads instead of spawning subprocesses. */
export function fakeMcp(servers: ConnectedMcpServer[] = [], tools: Tool[] = []): FakeMcp {
  const mcp: FakeMcp = {
    servers,
    tools,
    reloads: 0,
    nextReload: { connected: [], failed: [] },
    async reload() {
      mcp.reloads += 1;
      return mcp.nextReload;
    },
    async shutdown() {},
  };
  return mcp;
}

/**
 * A connected MCP server whose client answers from memory.
 *
 * `client` is deliberately untyped: the point of several of these fakes is to
 * return the shapes a real server sends but the SDK's types do not admit — a
 * resource with no `name`, for instance, which older servers still emit.
 */
export function fakeServer(name: string, client: Record<string, unknown> = {}): ConnectedMcpServer {
  return {
    config: { name, transport: 'stdio', command: 'noop', args: [], env: {}, enabled: true },
    client: client as unknown as ConnectedMcpServer['client'],
    remoteTools: [],
    async close() {},
  };
}

export interface TestContext extends CommandContext {
  mcp: FakeMcp;
  /** Text handed to `injectInput`, in order. */
  injected: string[];
  exited: boolean;
  cleared: boolean;
}

export interface TestContextOptions {
  provider?: Provider;
  mcp?: FakeMcp;
  /** Register an `injectInput` callback — /skill behaves differently without one. */
  withInjectInput?: boolean;
}

export function makeContext(options: TestContextOptions = {}): TestContext {
  const ctx: TestContext = {
    state: createAgentState(),
    provider: options.provider ?? createOllamaProvider(),
    setProvider(next) {
      ctx.provider = next;
    },
    clearHistory() {
      ctx.cleared = true;
      ctx.state.history.length = 0;
    },
    exit() {
      ctx.exited = true;
    },
    mcp: options.mcp ?? fakeMcp(),
    injected: [],
    exited: false,
    cleared: false,
  };
  if (options.withInjectInput) {
    ctx.injectInput = (text: string) => {
      ctx.injected.push(text);
    };
  }
  return ctx;
}

/** Runs a slash command by name, failing loudly when it is not registered. */
export async function run(ctx: CommandContext, name: string, args = ''): Promise<CommandResult> {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) throw new Error(`no such command: ${name}`);
  return await command.execute(ctx, args);
}

/** Runs a command and asserts it returned rendered text. */
export async function runText(ctx: CommandContext, name: string, args = ''): Promise<string> {
  const result = await run(ctx, name, args);
  if (typeof result !== 'string') {
    throw new Error(`${name} ${args} returned ${describe(result)}, expected a string`);
  }
  return result;
}

/** Runs a command and asserts it returned a form. */
export async function runForm(ctx: CommandContext, name: string, args = ''): Promise<FormSpec> {
  return asForm(await run(ctx, name, args), `${name} ${args}`);
}

/** Runs a command and asserts it returned a list picker. */
export async function runList(ctx: CommandContext, name: string, args = ''): Promise<ListSpec> {
  return asList(await run(ctx, name, args), `${name} ${args}`);
}

export function asForm(result: CommandResult, what = 'result'): FormSpec {
  if (!result || typeof result !== 'object' || result.kind !== 'form') {
    throw new Error(`${what} returned ${describe(result)}, expected a form`);
  }
  return result;
}

export function asList(result: CommandResult, what = 'result'): ListSpec {
  if (!result || typeof result !== 'object' || result.kind !== 'list') {
    throw new Error(`${what} returned ${describe(result)}, expected a list`);
  }
  return result;
}

export function asText(result: CommandResult, what = 'result'): string {
  if (typeof result !== 'string') {
    throw new Error(`${what} returned ${describe(result)}, expected a string`);
  }
  return result;
}

/** Submits a form and asserts the outcome is rendered text. */
export async function submitText(form: FormSpec, values: Record<string, string>): Promise<string> {
  return asText(await form.onSubmit(values), `${form.title} submit`);
}

/** Picks a list entry and asserts the outcome is rendered text. */
export async function pickText(list: ListSpec, value: string): Promise<string> {
  return asText(await list.onPick(value), `${list.title} pick(${value})`);
}

/** The values a picker offers, in order. */
export function values(list: ListSpec): string[] {
  return list.items.map((i) => i.value);
}

/** The keys a form asks for, in order. */
export function keys(form: FormSpec): string[] {
  return form.fields.map((f) => f.key);
}

/** Looks a form field up by key, failing loudly when the form dropped it. */
export function field(form: FormSpec, key: string): FormSpec['fields'][number] {
  const found = form.fields.find((f) => f.key === key);
  if (!found) throw new Error(`form "${form.title}" has no field "${key}"`);
  return found;
}

function describe(result: CommandResult): string {
  if (result === null) return 'null';
  if (typeof result === 'string') return `the string ${JSON.stringify(result)}`;
  return `a ${result.kind}`;
}
