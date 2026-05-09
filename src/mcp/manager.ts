// MCP manager — owns the connected-servers lifecycle, exposes the merged
// tool list, and lets callers reload after config changes.

import type { McpServerConfig } from '../config/schema.ts';
import { loadConfig } from '../config/load.ts';
import type { Tool } from '../tools/types.ts';
import { type ConnectedMcpServer, asLocalTool, connectMcpServer } from './client.ts';
import { setMcpServerProvider } from './resources.ts';

export interface McpManager {
  servers: ConnectedMcpServer[];
  tools: Tool[];
  reload(): Promise<{ connected: string[]; failed: { name: string; error: string }[] }>;
  shutdown(): Promise<void>;
}

export function createMcpManager(): McpManager {
  const state: { servers: ConnectedMcpServer[]; tools: Tool[] } = {
    servers: [],
    tools: [],
  };
  setMcpServerProvider(() => state.servers);

  async function disconnectAll(): Promise<void> {
    for (const s of state.servers) await s.close().catch(() => {});
    state.servers = [];
    state.tools = [];
  }

  return {
    get servers() {
      return state.servers;
    },
    get tools() {
      return state.tools;
    },
    async reload() {
      await disconnectAll();
      const enabled = loadConfig().config.mcpServers.filter(
        (s: McpServerConfig) => s.enabled,
      );
      const connected: string[] = [];
      const failed: { name: string; error: string }[] = [];

      for (const cfg of enabled) {
        try {
          const server = await connectMcpServer(cfg);
          state.servers.push(server);
          for (const r of server.remoteTools) state.tools.push(asLocalTool(server, r));
          connected.push(`${cfg.name} (${server.remoteTools.length} tools)`);
        } catch (e) {
          failed.push({ name: cfg.name, error: (e as Error).message });
        }
      }
      return { connected, failed };
    },
    async shutdown() {
      await disconnectAll();
    },
  };
}
