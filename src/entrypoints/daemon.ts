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
import { loadRules } from '../rules/loader.ts';
import { loadSouls } from '../soul/loader.ts';
import { closeBrowser } from '../tools/browser/session.ts';
import { setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';
import type { AgentState } from '../agent/loop.ts';
import { saveConversation, loadConversation } from '../agent/persistence.ts';

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

function formatToolStatus(name: string, input: Record<string, unknown>): string {
  // Concise single-line status for streaming bot placeholders. Pick the most
  // identifying field for common tools so the user sees what's happening.
  const arg =
    (typeof input['url'] === 'string' && input['url']) ||
    (typeof input['path'] === 'string' && input['path']) ||
    (typeof input['query'] === 'string' && input['query']) ||
    (typeof input['command'] === 'string' && input['command']) ||
    (typeof input['title'] === 'string' && input['title']) ||
    '';
  const trimmed = arg.length > 80 ? `${arg.slice(0, 80)}…` : arg;
  return trimmed ? `${name} · ${trimmed}` : name;
}

const conversations = new Map<string, AgentState>();
function stateFor(chatId: string): AgentState {
  let state = conversations.get(chatId);
  if (!state) {
    state = createAgentState();
    const restored = loadConversation(chatId);
    if (restored.length > 0) {
      state.history = restored;
      log.info({ chatId, messages: restored.length }, 'restored conversation');
    }
    conversations.set(chatId, state);
  }
  return state;
}

const manager = createBotManager(loaded);

const { tryHandleBotCommand } = await import('../bots/commands.ts');
const { runWithSession } = await import('../agent/context.ts');

manager
  .start(async (msg, hopts) => {
    log.debug({ chatId: msg.chatId }, 'incoming message');
    const state = stateFor(msg.chatId);
    const sessionId = `bot:${msg.chatId}`;
    const sink = hopts?.sink;

    // Bot-level slash commands run inside the chat's session ALS scope so
    // they can read/mutate per-session state (tasks, plan mode). Handled
    // directly without spending tokens on the agent.
    const handled = await runWithSession({ id: sessionId, scope: 'unknown' }, async () =>
      tryHandleBotCommand(msg.text, { state, providerName: provider.name }),
    );
    if (handled) {
      log.debug({ chatId: msg.chatId, command: msg.text.split(' ')[0] }, 'bot command');
      sink?.({ type: 'final' });
      // Note: heartbeat hasn't been created yet at this branch (declared
      // below the slash-command check). Nothing to clear here.
      return handled;
    }

    const rules = loadRules();
    const session = { id: sessionId, scope: 'unknown' as const };
    const souls = loadSouls(process.cwd(), session);
    const cfg = loadConfig().config;
    const hooks = cfg.hooks;
    const outputStyle = await import('../output-styles/styles.ts').then((m) =>
      m.findOutputStyle(cfg.outputStyle),
    );

    // Silence detector — Ollama doesn't stream tool_call arguments, so a
    // model generating a multi-thousand-line Write payload looks identical
    // to a hang. Push a periodic heartbeat to the sink so bots can show
    // "generating · 45s of silence" instead of a stale placeholder.
    let lastSig = Date.now();
    const botBump = (): void => {
      lastSig = Date.now();
    };
    const heartbeat = setInterval(() => {
      const silenceSec = Math.floor((Date.now() - lastSig) / 1000);
      if (silenceSec >= 20) {
        sink?.({
          type: 'status',
          text: `generating · ${silenceSec}s of silence (no content stream — likely a large tool input)`,
        });
      }
    }, 15_000);
    if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
      (heartbeat as { unref?: () => void }).unref?.();
    }

    const attachments: Array<{ kind: string; path: string; caption?: string }> = [];
    const turn = await runAgentTurn(provider, state, msg.text, {
      // Per-user isolation — every chatId gets its own task list, plan-mode
      // flag, browser context, monitored processes, etc. Telegram + WhatsApp
      // share this code path; the chatId itself is unique enough across
      // transports that we don't need to disambiguate here.
      session,
      rules,
      souls,
      hooks,
      ...(outputStyle ? { outputStyle } : {}),
      // Streaming: forward per-token deltas to the sink as they arrive.
      // Also fire a 'text' event from the post-turn whole-text callback so
      // bots running against a non-streaming provider (or Ollama models that
      // ignore stream:true for tool-only turns) still get something to show.
      // The sink-side Telegram adapter dedupes by tracking whether deltas
      // have already arrived for the current turn — see streamMode='stream'.
      onAssistantText: (t) => {
        botBump();
        sink?.({ type: 'text-final', text: t });
      },
      onAssistantDelta: (d) => {
        botBump();
        sink?.({ type: 'text', text: d });
      },
      // Surface chain-of-thought activity as a status event so Telegram's
      // status / stream modes can show "thinking · N chars" instead of
      // a static placeholder during long reasoning phases.
      onAssistantThinking: (() => {
        let lastReported = 0;
        let total = 0;
        return (d: string) => {
          botBump();
          total += d.length;
          // Throttle: only emit every 200 chars to avoid edit-spam in the
          // bot adapter (already rate-limited to 1 edit/sec, but no point
          // queuing 100 redundant updates).
          if (total - lastReported >= 200) {
            lastReported = total;
            sink?.({ type: 'status', text: `thinking · ${total} chars` });
          }
        };
      })(),
      onToolUse: (name, input) => {
        log.debug({ tool: name, input }, 'tool_use');
        sink?.({ type: 'status', text: formatToolStatus(name, input) });
      },
      onToolResult: (name, _output, isError) =>
        isError ? log.warn({ tool: name }, 'tool_error') : undefined,
      onRetry: (attempt, delayMs, why) => {
        log.warn({ attempt, delayMs, why }, 'provider retry');
        sink?.({ type: 'status', text: `retrying provider (${attempt}) — ${why}` });
      },
      onHook: (result) =>
        log.info(
          { hook: result.hook, exit: result.exitCode, ms: result.durationMs },
          'hook fired',
        ),
      onAttachment: (a: { kind: string; path: string; caption?: string }) =>
        attachments.push(a),
    });
    clearInterval(heartbeat);
    saveConversation(msg.chatId, state.history);
    sink?.({ type: 'final' });
    if (turn.reason !== 'end-turn')
      log.warn({ chatId: msg.chatId, reason: turn.reason }, 'turn ended early');
    if (attachments.length > 0)
      log.info({ chatId: msg.chatId, attachments: attachments.length }, 'sending attachments');
    return {
      text: turn.finalText,
      attachments: attachments.map((a) => {
        const out: { kind: 'image' | 'video' | 'audio' | 'document'; path: string; caption?: string } = {
          kind: (['image', 'video', 'audio', 'document'].includes(a.kind)
            ? a.kind
            : 'document') as 'image' | 'video' | 'audio' | 'document',
          path: a.path,
        };
        if (a.caption !== undefined) out.caption = a.caption;
        return out;
      }),
    };
  })
  .then((started) => log.info({ adapters: started }, 'adapters started'))
  .catch((e) => log.error({ err: e }, 'failed to start adapters'));

const HEARTBEAT_MS = (loaded.config.daemon.heartbeatSeconds ?? 60) * 1000;
const interval = setInterval(() => log.debug('heartbeat'), HEARTBEAT_MS);
interval.unref();
const keepAlive = setInterval(() => {}, 1 << 30);

// Scheduler — fires one-shot wakeups and cron jobs on schedule. Each firing
// runs the prompt through the same agent loop the bots use, with a fresh
// state, so its output doesn't blend into anyone's chat history.
const { createScheduler } = await import('../daemon/scheduler.ts');
const scheduler = createScheduler({
  log: (event) => log.info(event, 'scheduler'),
  dispatch: async (prompt, source) => {
    const sched = createAgentState();
    const rules = loadRules();
    const session = { id: `scheduled:${source}`, scope: 'scheduled' as const };
    const souls = loadSouls(process.cwd(), session);
    const sCfg = loadConfig().config;
    const hooks = sCfg.hooks;
    const sStyle = await import('../output-styles/styles.ts').then((m) =>
      m.findOutputStyle(sCfg.outputStyle),
    );
    const result = await runAgentTurn(provider, sched, prompt, {
      session,
      rules,
      souls,
      hooks,
      ...(sStyle ? { outputStyle: sStyle } : {}),
      onToolUse: (name) => log.debug({ tool: name }, 'scheduled tool_use'),
    });
    log.info(
      { source, reason: result.reason, finalText: result.finalText.slice(0, 200) },
      'scheduled run finished',
    );
  },
});
scheduler.start();

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutdown');
  clearInterval(interval);
  clearInterval(keepAlive);
  scheduler.stop();
  await manager.stop().catch(() => {});
  await mcp.shutdown().catch(() => {});
  await closeBrowser().catch(() => {});
  setTimeout(() => process.exit(0), 100);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error({ err: e }, 'uncaught'));
process.on('unhandledRejection', (e) => log.error({ err: e }, 'unhandled rejection'));
