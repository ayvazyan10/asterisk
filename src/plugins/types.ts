// The plugin contract.
//
// Read this before writing one, because the security position is the whole
// design: a plugin is a TypeScript module imported into the agent's own
// process. It runs with everything Asterisk has — the SQLite store holding
// your API keys, the tool registry, the permission gate itself. Nothing
// confines it.
//
// The sandbox does not help here, and the roadmap's "probably needs a sandbox
// first" turned out to be the wrong prerequisite. bubblewrap confines child
// *processes*; a plugin is not a child process, it is a function call. Making
// plugins genuinely isolated would mean running them out-of-process behind a
// tool interface over stdio — which is MCP, which Asterisk already speaks as a
// client. So there is no second isolated plugin mechanism here, deliberately:
//
//   * code you wrote or read → a plugin, in-process, full power
//   * code you did not       → an MCP server, isolated by being a process
//
// That is why loading is off by default and every plugin is named explicitly
// in configuration. There is no directory scan: dropping a file somewhere must
// never be enough to get code into this process.

import type { HookEvent } from '../config/schema.ts';
import type { Tool } from '../tools/types.ts';

/** What a lifecycle handler is told about the event it is handling. */
export interface PluginEventContext {
  event: HookEvent;
  tool?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolOutput?: string | undefined;
  toolError?: boolean | undefined;
  userText?: string | undefined;
  finalText?: string | undefined;
}

/**
 * What a handler may say back.
 *
 * `block` refuses the tool call; anything else lets it proceed. Mirrors the
 * shell-hook decision in hooks/runner.ts on purpose — one vocabulary for the
 * two ways of hooking the loop, rather than two that drift.
 */
export type PluginDecision = { action: 'block'; reason: string } | undefined;

export interface PluginApi {
  /** Adds a tool to the registry for the lifetime of the process. */
  registerTool(tool: Tool): void;
  /** Runs `handler` on a lifecycle event. */
  on(event: HookEvent, handler: (ctx: PluginEventContext) => Promise<PluginDecision>): void;
  /** Writes a line to the transcript, tagged with the plugin's name. */
  log(message: string): void;
}

export interface AsteriskPlugin {
  /** Shown in `/plugins` and in log lines. */
  name: string;
  /** Optional, for the listing only. */
  description?: string;
  register(api: PluginApi): void | Promise<void>;
}

/** A plugin module's default export, or a named `plugin` export. */
export interface PluginModule {
  default?: AsteriskPlugin;
  plugin?: AsteriskPlugin;
}
