// MCP client — connects to a configured MCP server and exposes its tools to
// Asterisk's agent loop. Uses the official @modelcontextprotocol/sdk.
//
// Reference: https://github.com/modelcontextprotocol/typescript-sdk

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpServerConfig } from '../config/schema.ts';
import { type Tool, ok, err } from '../tools/types.ts';

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

export async function connectMcpServer(
  config: McpServerConfig,
): Promise<ConnectedMcpServer> {
  const client = new Client({ name: 'asterisk', version: '0.1.0' }, { capabilities: {} });

  if (config.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
    });
    await client.connect(transport);
  } else {
    // The SDK's StreamableHTTPClientTransport types `sessionId` as `string |
    // undefined` while the Transport interface declares it `string`. Under
    // exactOptionalPropertyTypes that's an incompatibility we resolve at the
    // boundary; the SDK accepts it at runtime.
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    }) as unknown as Parameters<Client['connect']>[0];
    await client.connect(transport);
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
