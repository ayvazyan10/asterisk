// `asterisk mcp-server` — serve Asterisk over MCP on stdio, so another agent
// can use Asterisk's memory, skills and rules.
//
// Transport only. What is served, and the argument for why it is that and not
// more, lives in src/mcp/server.ts — which is also why this file has no tests
// of its own: tests/mcp-server.test.ts drives the same server through the SDK's
// in-memory transport instead of spawning a process.
//
// stdout carries JSON-RPC frames and nothing else. Anything Asterisk would
// normally print would be read by the client as a malformed frame, so every
// diagnostic goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAsteriskMcpServer } from '../mcp/server.ts';

const USAGE = `asterisk mcp-server — expose Asterisk to other agents over MCP (stdio)

Usage:
  asterisk mcp-server [--read-only]

Flags:
  --read-only   Serve memory for searching only; do not register the tools
                that write or delete notes.

Serves Asterisk's long-term memory as tools, its skills as prompts and its
rules as resources. No shell, filesystem or agent-turn tool is exposed.
`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const readOnly = process.argv.includes('--read-only');
  const server = createAsteriskMcpServer({ writable: !readOnly });

  // A client that goes away leaves this process holding a database handle, so
  // both signals close the server rather than letting the runtime take it.
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  process.stderr.write(`asterisk mcp-server: ready on stdio${readOnly ? ' (read-only)' : ''}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`asterisk mcp-server: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
