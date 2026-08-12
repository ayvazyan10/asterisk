// Daemon entrypoint — long-running process body.
// Loads config, starts enabled bot adapters, pipes incoming messages through
// the agent loop with a per-chat conversation pool.

import { createAgentState, runAgentTurn } from '../agent/loop.ts';
import type { AgentState } from '../agent/loop.ts';
import { loadConversation, saveConversation } from '../agent/persistence.ts';
import { createBotManager } from '../bots/manager.ts';
import { loadConfig } from '../config/load.ts';
import { createDaemonLogger } from '../daemon/logger.ts';
import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { closeDb } from '../db/index.ts';
import { createMcpManager } from '../mcp/manager.ts';
import { initialisePlugins } from '../plugins/runtime.ts';
import { chooseProvider } from '../providers/factory.ts';
import { loadRules } from '../rules/loader.ts';
import { loadSouls } from '../soul/loader.ts';
import { closeBrowser } from '../tools/browser/session.ts';
import { setExtraTools } from '../tools/registry.ts';
import type { Provider } from '../types/messages.ts';
import { KeyedQueue } from '../utils/keyed-queue.ts';

const paths = asteriskPaths();
ensurePaths(paths);
const log = createDaemonLogger(paths.daemonLog);
log.info({ pid: process.pid }, 'asterisk daemon starting');

const loaded = loadConfig();

function pickProvider(): Provider {
  const chosen = chooseProvider(loaded);
  if (chosen.fallbackReason) {
    log.warn({ reason: chosen.fallbackReason, using: chosen.kind }, 'provider fallback');
  }
  return chosen.provider;
}

const provider = pickProvider();
log.info({ provider: provider.name }, 'provider ready');

const pluginLoad = await initialisePlugins();
for (const line of pluginLoad.errors) log.warn({ plugin: line }, 'plugin not loaded');
for (const line of pluginLoad.notices) log.info({ plugin: line }, 'plugin');

const mcp = createMcpManager();
mcp
  .reload()
  .then((res) => {
    setExtraTools(mcp.tools);
    log.info({ connected: res.connected, failed: res.failed.map((f) => f.name) }, 'mcp servers');
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

/**
 * Chats kept resident. Every chat that has ever messaged the bot used to stay
 * in memory for the daemon's lifetime, which on a busy bot is unbounded growth.
 * Evicted chats are re-hydrated from disk on their next message — the restore
 * path below already exists for exactly that.
 */
const MAX_RESIDENT_CHATS = 100;

const conversations = new Map<string, AgentState>();

/** Serialises turns per chat. See src/utils/keyed-queue.ts for why. */
const turnQueue = new KeyedQueue();

function stateFor(chatId: string): AgentState {
  const existing = conversations.get(chatId);
  if (existing) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this chat to the end and makes the first key the least recently used.
    conversations.delete(chatId);
    conversations.set(chatId, existing);
    return existing;
  }

  const state = createAgentState();
  const restored = loadConversation(chatId);
  if (restored.length > 0) {
    state.history = restored;
    log.info({ chatId, messages: restored.length }, 'restored conversation');
  }
  conversations.set(chatId, state);

  while (conversations.size > MAX_RESIDENT_CHATS) {
    const oldest = conversations.keys().next();
    if (oldest.done) break;
    // Never evict a chat mid-turn — its state is being mutated.
    if (turnQueue.isBusy(oldest.value)) break;
    const evicted = conversations.get(oldest.value);
    if (evicted) saveConversation(oldest.value, evicted.history);
    conversations.delete(oldest.value);
    log.debug({ chatId: oldest.value }, 'evicted idle conversation');
  }

  return state;
}

const manager = createBotManager(loaded);

const { tryHandleBotCommand } = await import('../bots/commands.ts');
const { runWithSession } = await import('../agent/context.ts');

manager
  // Serialised per chat. grammy dispatches updates concurrently, so two
  // messages arriving in one chat within a second used to run runAgentTurn
  // against the same mutable AgentState, interleaving their history pushes and
  // stranding tool_use blocks between another turn's pairs.
  .start(async (msg, hopts) =>
    turnQueue.run(msg.chatId, async () => {
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
        // flag, browser context, monitored processes, etc. Every transport
        // shares this code path; the chatId itself is unique enough across
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
          // Summary only. Logging the raw input put whole Write payloads and
          // every Bash command line into daemon.log — which the control panel
          // then serves over /api/logs.
          log.debug({ tool: name, summary: formatToolStatus(name, input) }, 'tool_use');
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
        onAttachment: (a: { kind: string; path: string; caption?: string }) => attachments.push(a),
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
          const out: {
            kind: 'image' | 'video' | 'audio' | 'document';
            path: string;
            caption?: string;
          } = {
            kind: (['image', 'video', 'audio', 'document'].includes(a.kind)
              ? a.kind
              : 'document') as 'image' | 'video' | 'audio' | 'document',
            path: a.path,
          };
          if (a.caption !== undefined) out.caption = a.caption;
          return out;
        }),
      };
    }),
  )
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
  // Checkpoint the WAL and release the database file.
  closeDb();
  setTimeout(() => process.exit(0), 100);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// Fail fast rather than serving from an unknown state. Logging and continuing
// meant the daemon kept answering messages after, say, an EPIPE from a hook
// unwound the middle of a turn — the project's own rule is that errors are
// never silently swallowed. A supervisor (systemd, pm2, Docker) restarts us;
// where there is none, exiting is still better than replying from a corrupted
// conversation.
function fatal(kind: string, e: unknown): void {
  log.error({ err: e }, kind);
  void shutdown(kind).finally(() => process.exit(1));
  // shutdown() gives the WAL a chance to checkpoint, but never let a hung
  // shutdown keep a broken daemon alive.
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('uncaughtException', (e) => fatal('uncaught', e));
process.on('unhandledRejection', (e) => fatal('unhandled rejection', e));
