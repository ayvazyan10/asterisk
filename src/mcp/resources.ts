import { type Tool, err, ok } from '../tools/types.ts';
import type { ConnectedMcpServer } from './client.ts';

let getServers: () => readonly ConnectedMcpServer[] = () => [];

export function setMcpServerProvider(provider: () => readonly ConnectedMcpServer[]): void {
  getServers = provider;
}

export const MCP_RESOURCE_TOOLS: Tool[] = [
  {
    name: 'McpListResources',
    description: 'List resources exposed by connected MCP servers.',
    input_schema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional MCP server name.' },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const filter = typeof input['server'] === 'string' ? input['server'] : undefined;
      const servers = getServers().filter((s) => !filter || s.config.name === filter);
      if (servers.length === 0) return ok('(no matching MCP servers connected)');
      const lines: string[] = [];
      for (const server of servers) {
        try {
          const listed = await server.client.listResources();
          lines.push(`${server.config.name}: ${listed.resources.length} resource(s)`);
          for (const r of listed.resources) {
            const name = r.name ? ` ${r.name}` : '';
            const mime = r.mimeType ? ` [${r.mimeType}]` : '';
            lines.push(`  ${r.uri}${name}${mime}`);
          }
        } catch (e) {
          lines.push(`${server.config.name}: resources unavailable (${(e as Error).message})`);
        }
      }
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'McpReadResource',
    description: 'Read a resource from a connected MCP server by URI.',
    input_schema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name.' },
        uri: { type: 'string', description: 'Resource URI to read.' },
      },
      required: ['server', 'uri'],
      additionalProperties: false,
    },
    async execute(input) {
      const serverName = typeof input['server'] === 'string' ? input['server'] : '';
      const uri = typeof input['uri'] === 'string' ? input['uri'] : '';
      if (!serverName) return err('server is required');
      if (!uri) return err('uri is required');
      const server = getServers().find((s) => s.config.name === serverName);
      if (!server) return err(`MCP server not connected: ${serverName}`);
      try {
        const resource = await server.client.readResource({ uri });
        const parts = resource.contents.map((item) => {
          if ('text' in item && typeof item.text === 'string') return item.text;
          return JSON.stringify(item);
        });
        const output = parts.join('\n');
        return ok(output.length > 50000 ? `${output.slice(0, 50000)}\n[truncated]` : output);
      } catch (e) {
        return err(`MCP resource read failed: ${(e as Error).message}`);
      }
    },
  },
];
