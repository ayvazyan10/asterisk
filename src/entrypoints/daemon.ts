// Daemon entrypoint — long-running process body.
// Loads config, starts enabled bot adapters, pipes incoming messages through
// the agent loop with a per-chat conversation pool.

import { createAgentState, runAgentTurn } from '../agent/loop.ts';
import { createBotManager } from '../bots/manager.ts';
import { loadConfig } from '../config/load.ts';
import { createDaemonLogger } from '../daemon/logger.ts';
import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { createMcpManager } from '../mcp/manager.ts';
import { createAnthropicProvider } from '../providers/anthropic.ts';
import { createOllamaProvider } from '../providers/ollama.ts';
import { setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';
import type { AgentState } from '../agent/loop.ts';

const paths = asteriskPaths();
ensurePaths(paths);
const log = createDaemonLogger(paths.daemonLog);
log.info({ pid: process.pid }, 'asterisk daemon starting');

const loaded = loadConfig();

function pickProvider(): Provider {
  if (loaded.config.provider === 'anthropic') {
    if (!loaded.secrets.ANTHROPIC_API_KEY) {
      log.warn('anthropic provider configured but ANTHROPIC_API_KEY missing; falling back to ollama');
      return createOllamaProvider();
    }
    return createAnthropicProvider({
      apiKey: loaded.secrets.ANTHROPIC_API_KEY,
      model: loaded.config.anthropic.model,
    });
  }
  return createOllamaProvider({
    baseUrl: loaded.config.ollama.baseUrl,
    model: loaded.config.ollama.model,
    contextWindow: loaded.config.ollama.contextWindow,
  });
}

const provider = pickProvider();
log.info({ provider: provider.name }, 'provider ready');

const mcp = createMcpManager();
mcp
  .reload()
  .then((res) => {
    setExtraTools(mcp.tools);
    log.info(
      { connected: res.connected, failed: res.failed.map((f) => f.name) },
      'mcp servers',
    );
  })
  .catch((e) => log.warn({ err: e }, 'mcp reload failed'));

const conversations = new Map<string, AgentState>();
function stateFor(chatId: string): AgentState {
  let state = conversations.get(chatId);
  if (!state) {
    state = createAgentState();
    conversations.set(chatId, state);
  }
  return state;
}

const manager = createBotManager(loaded);

manager
  .start(async (msg) => {
    log.debug({ chatId: msg.chatId }, 'incoming message');
    const state = stateFor(msg.chatId);
    const turn = await runAgentTurn(provider, state, msg.text, {
      onToolUse: (name, input) => log.debug({ tool: name, input }, 'tool_use'),
      onToolResult: (name, _output, isError) =>
        isError ? log.warn({ tool: name }, 'tool_error') : undefined,
      onRetry: (attempt, delayMs, why) =>
        log.warn({ attempt, delayMs, why }, 'provider retry'),
    });
    if (turn.reason !== 'end-turn') log.warn({ chatId: msg.chatId, reason: turn.reason }, 'turn ended early');
    return turn.finalText;
  })
  .then((started) => log.info({ adapters: started }, 'adapters started'))
  .catch((e) => log.error({ err: e }, 'failed to start adapters'));

const HEARTBEAT_MS = (loaded.config.daemon.heartbeatSeconds ?? 60) * 1000;
const interval = setInterval(() => log.debug('heartbeat'), HEARTBEAT_MS);
interval.unref();
const keepAlive = setInterval(() => {}, 1 << 30);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutdown');
  clearInterval(interval);
  clearInterval(keepAlive);
  await manager.stop().catch(() => {});
  await mcp.shutdown().catch(() => {});
  setTimeout(() => process.exit(0), 100);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error({ err: e }, 'uncaught'));
process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandled rejection'));
