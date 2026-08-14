// MCP client — connects to a configured MCP server and exposes its tools to
// Asterisk's agent loop. Uses the official @modelcontextprotocol/sdk.
//
// Reference: https://github.com/modelcontextprotocol/typescript-sdk

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpServerConfig } from '../config/schema.ts';
import { getDb } from '../db/index.ts';
import { readMcpAccessToken } from '../db/mcp-credentials.ts';
import { type Tool, err, ok } from '../tools/types.ts';
import { ConsentRequiredError, createConnectorAuthProvider } from './oauth/provider.ts';

interface RemoteToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface ConnectedMcpServer {
  config: McpServerConfig;
  client: Client;
  remoteTools: RemoteToolDefinition[];
  close(): Promise<void>;
}

/**
 * Variables a spawned MCP server needs to function at all.
 *
 * Everything else is withheld. An MCP server is third-party code the user
 * installed by name, and it runs with the user's privileges; handing it the
 * whole environment handed it ANTHROPIC_API_KEY, the Telegram bot token,
 * GITHUB_TOKEN, AWS_* and every other credential in the shell that started
 * Asterisk. A server that genuinely needs a secret should be given it
 * explicitly through the server's own `env` block, where it is visible in
 * `/mcp` and in the control panel.
 */
const STDIO_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  'TERM',
  // Windows needs these to resolve interpreters and temp storage at all.
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramData',
  'ProgramFiles',
] as const;

/** Builds the environment for a stdio MCP server: allowlist plus its own env. */
export function stdioEnv(configured: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of STDIO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // The server's declared env wins — that is the supported way to pass a
  // credential to one specific server.
  return { ...env, ...configured };
}

/**
 * Rewrites an authorization failure into the sentence that fixes it.
 *
 * The SDK throws a bare `UnauthorizedError` whether the token expired, the
 * refresh was rejected, or there was never a token at all. All three end in
 * the same place for the user, and "HTTP 401" in a startup log does not say
 * so.
 */
/**
 * The Authorization header for a `token` connector, or nothing.
 *
 * Nothing rather than throwing: a connector whose token has not been supplied
 * yet should fail against the endpoint with its own 401, which
 * `authFailure` turns into the sentence naming the fix — the same path an
 * expired OAuth token takes.
 */
function bearerHeader(name: string, url: string): Record<string, string> {
  const token = readMcpAccessToken(getDb(), name, url);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function authFailure(name: string, e: unknown): Error {
  if (e instanceof ConsentRequiredError) return e;
  if (e instanceof UnauthorizedError) {
    return new Error(`authorization expired or rejected — run: /mcp connect ${name}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

export async function connectMcpServer(config: McpServerConfig): Promise<ConnectedMcpServer> {
  const client = new Client({ name: 'asterisk', version: '0.1.0' }, { capabilities: {} });

  if (config.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: stdioEnv(config.env),
    });
    await client.connect(transport);
  } else {
    // A connector (auth: 'oauth') gets a provider that reads the stored token
    // and lets the SDK refresh it when the endpoint answers 401. It is
    // deliberately non-interactive: this function runs at startup, inside the
    // daemon, and from a bot turn, where opening a browser and waiting five
    // minutes on a consent screen is not an option. A server that needs fresh
    // consent surfaces as a connect failure naming the command that fixes it.
    const authProvider =
      config.auth === 'oauth'
        ? createConnectorAuthProvider({
            serverName: config.name,
            serverUrl: config.url,
            scopes: config.scopes,
          })
        : undefined;

    // `token` is the mode for endpoints whose authorization server offers no
    // dynamic client registration, so OAuth is closed to us and the user
    // supplies a token instead. It lives in mcp_credentials rather than in
    // `headers` — same reason as an OAuth token: headers are exported.
    const headers =
      config.auth === 'token'
        ? { ...config.headers, ...bearerHeader(config.name, config.url) }
        : config.headers;

    // The SDK's StreamableHTTPClientTransport types `sessionId` as `string |
    // undefined` while the Transport interface declares it `string`. Under
    // exactOptionalPropertyTypes that's an incompatibility we resolve at the
    // boundary; the SDK accepts it at runtime.
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
      ...(authProvider ? { authProvider } : {}),
    }) as unknown as Parameters<Client['connect']>[0];
    try {
      await client.connect(transport);
    } catch (e) {
      throw authFailure(config.name, e);
    }
  }

  const listed = await client.listTools();
  const remoteTools: RemoteToolDefinition[] = listed.tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    inputSchema: t.inputSchema,
  }));

  return {
    config,
    client,
    remoteTools,
    async close() {
      await client.close().catch(() => {});
    },
  };
}

// Wrap a remote MCP tool as one of Asterisk's local Tool entries. The agent
// loop is provider-neutral and only knows about the local Tool shape; this
// adapter forwards execute() calls through MCP.
export function asLocalTool(server: ConnectedMcpServer, remote: RemoteToolDefinition): Tool {
  const schema = (remote.inputSchema ?? {
    type: 'object',
    properties: {},
    additionalProperties: true,
  }) as Tool['input_schema'];

  return {
    // Namespace the tool name so two MCP servers can each expose a tool
    // called `search` without colliding.
    name: `${server.config.name}__${remote.name}`,
    description:
      remote.description ?? `MCP tool from ${server.config.name} (no description provided)`,
    input_schema:
      schema.type === 'object'
        ? schema
        : {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
    async execute(input) {
      try {
        const res = await server.client.callTool({
          name: remote.name,
          arguments: input as Record<string, unknown>,
        });
        const text = formatToolContent(res.content);
        if (res.isError) return err(text || 'mcp tool returned error');
        return ok(text);
      } catch (e) {
        return err(`mcp call failed: ${(e as Error).message}`);
      }
    },
  };
}

function formatToolContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
        continue;
      }
    }
    parts.push(JSON.stringify(block));
  }
  return parts.join('\n');
}
