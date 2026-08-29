// Daemon entrypoint — long-running process body.
// Loads config, starts enabled bot adapters, pipes incoming messages through
// the agent loop with a per-chat conversation pool.

import { createAgentState, runAgentTurn } from '../agent/loop.ts';
import type { AgentState, AgentTurnResult } from '../agent/loop.ts';
import { loadConversation, saveConversation } from '../agent/persistence.ts';
import { attachChatApprovals } from '../bots/approval-bridge.ts';
import { discardImages, intakeImage } from '../bots/image-intake.ts';
import {
  clearTurn,
  currentEpoch,
  formatStopAck,
  interrupt,
  isStale,
  noteDequeued,
  noteQueued,
  registerTurn,
} from '../bots/interrupt.ts';
import { createBotManager } from '../bots/manager.ts';
import { intakeVoice } from '../bots/voice-intake.ts';
import { loadConfig } from '../config/load.ts';
import { createDaemonLogger } from '../daemon/logger.ts';
import { asteriskPaths, ensurePaths } from '../daemon/paths.ts';
import { closeDb } from '../db/index.ts';
import { createMcpManager } from '../mcp/manager.ts';
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

const { tryHandleBotCommand, resolveOutputStyle, parseBotCommand } = await import(
  '../bots/commands.ts'
);
const { runWithSession } = await import('../agent/context.ts');

manager
  // Serialised per chat. grammy dispatches updates concurrently, so two
  // messages arriving in one chat within a second used to run runAgentTurn
  // against the same mutable AgentState, interleaving their history pushes and
  // stranding tool_use blocks between another turn's pairs.
  .start(async (msg, hopts) => {
    // /stop is answered *outside* that queue, and has to be: the queue runs
    // one turn at a time in submission order, so a /stop routed the ordinary
    // way would wait for the very turn it was sent to kill. See
    // src/bots/interrupt.ts for the whole mechanism.
    //
    // Spoken input is exempt for the same reason the slash commands below
    // are: a transcript that happens to begin with "/" is a homophone
    // Whisper heard, not a command the user typed. A picture's caption is
    // exempt too, and for a second reason: this branch returns before the
    // queue, and the queue is the one owner of the downloaded file.
    if (!msg.voice && !msg.image && parseBotCommand(msg.text)?.cmd === 'stop') {
      const result = interrupt(msg.chatId);
      // The aborted turn's own signal already denies whatever permission
      // request it was waiting on. The question rendered in the chat is a
      // separate object and keeps live buttons until it is withdrawn.
      const cancelledApprovals = manager.cancelApprovals(msg.chatId);
      log.info({ chatId: msg.chatId, ...result, cancelledApprovals }, 'stop requested');
      hopts?.sink?.({ type: 'final' });
      return { text: formatStopAck({ ...result, cancelledApprovals }) };
    }

    // Read before entering the queue and compared when the job starts: if an
    // interrupt lands in between, this message was already queued when the
    // user asked for everything to stop, and must not run.
    const epochAtEnqueue = currentEpoch(msg.chatId);
    noteQueued(msg.chatId);

    const queued = turnQueue.run(msg.chatId, async () => {
      // Staleness is read first: the dequeue that empties a chat drops its
      // entry, and the epoch goes with it.
      const stale = isStale(msg.chatId, epochAtEnqueue);
      noteDequeued(msg.chatId);
      if (stale) {
        log.info({ chatId: msg.chatId }, 'dropped queued message after /stop');
        hopts?.sink?.({ type: 'final' });
        // Nothing to say: the /stop acknowledgement already reported this
        // message as dropped, and an empty text sends no Telegram message.
        return { text: '' };
      }

      // Registered before any of the turn's own work rather than just before
      // the model call: intakeVoice below can spend tens of seconds
      // transcribing on a local model, and a /stop typed during that window
      // used to be answered "nothing to stop" — and then the turn ran anyway.
      // The loop checks the signal at the top of its first iteration, so a
      // turn aborted in here ends without issuing a single provider request.
      const ctrl = new AbortController();
      registerTurn(msg.chatId, ctrl);
      try {
        log.debug({ chatId: msg.chatId }, 'incoming message');
        const state = stateFor(msg.chatId);
        const sessionId = `bot:${msg.chatId}`;
        const sink = hopts?.sink;

        // A voice message becomes text before anything else looks at it.
        // Transcription can take tens of seconds on a large local model, so the
        // chat is told what is happening rather than sitting on a stale spinner.
        if (msg.voice) sink?.({ type: 'status', text: 'transcribing voice message…' });
        const intake = await intakeVoice(msg);
        let userText = intake.text;
        if (intake.outcome) {
          if (intake.outcome.ok) {
            log.info(
              { chatId: msg.chatId, backend: intake.outcome.backend, chars: userText.length },
              'voice transcribed',
            );
          } else {
            log.warn(
              { chatId: msg.chatId, err: intake.outcome.error },
              'voice transcription failed',
            );
          }
        }

        // A picture is settled before anything else runs: a model that cannot
        // see one must say so rather than answering the caption alone, and the
        // file is deleted on that path here rather than left behind.
        const images = await intakeImage({ ...msg, text: userText }, provider);
        if (images.kind === 'refused') {
          log.info({ chatId: msg.chatId, why: images.reason }, 'image refused');
          sink?.({ type: 'final' });
          return { text: images.reply };
        }
        userText = images.text;

        // Bot-level slash commands run inside the chat's session ALS scope so
        // they can read/mutate per-session state (tasks, plan mode). Handled
        // directly without spending tokens on the agent.
        //
        // Spoken input is exempt: a transcript that happens to begin with "/"
        // is a sentence Whisper heard, not a command the user typed, and running
        // it as one would act on a homophone.
        const handled = msg.voice
          ? null
          : await runWithSession({ id: sessionId, scope: 'unknown' }, async () =>
              tryHandleBotCommand(userText, { state, providerName: provider.name }),
            );
        if (handled) {
          log.debug({ chatId: msg.chatId, command: userText.split(' ')[0] }, 'bot command');
          sink?.({ type: 'final' });
          // The heartbeat hasn't been created yet at this branch (declared
          // below the slash-command check), so there is no interval to clear.
          // The controller registered above is released by the outer finally,
          // on this path like every other.
          return handled;
        }

        const rules = loadRules();
        const session = { id: sessionId, scope: 'unknown' as const };
        const souls = loadSouls(process.cwd(), session);
        const cfg = loadConfig().config;
        const hooks = cfg.hooks;
        // Session-first, same precedence loadSouls already applies above: a
        // chat's own /style choice (if any) wins over the daemon-wide default.
        const outputStyle = resolveOutputStyle(session, cfg.outputStyle);

        // Silence detector — some servers don't stream tool_call arguments, so a
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
        let turn: AgentTurnResult;
        try {
          turn = await runAgentTurn(provider, state, userText, {
            signal: ctrl.signal,
            // Empty unless this message carried a picture the gate accepted.
            images: images.images,
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
            // bots running against a non-streaming provider (or models that
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
            onAttachment: (a: { kind: string; path: string; caption?: string }) =>
              attachments.push(a),
          });
        } finally {
          // This used to run only on the success path, so an aborted or
          // throwing turn leaked its interval.
          clearInterval(heartbeat);
        }
        saveConversation(msg.chatId, state.history);
        sink?.({ type: 'final' });
        // An aborted turn is reported like any other: whatever text it managed
        // to produce is the reply, and when there is none the reply is empty —
        // the /stop acknowledgement has already said what happened, so the
        // transport must not add a second message on top of it.
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
      } finally {
        // One owner per resource: this releases the chat's interrupt slot on
        // every path out of the job — the bot-command early return included.
        // The heartbeat has a finally of its own, next to where it is made.
        clearTurn(msg.chatId, ctrl);
      }
    });

    // Someone's photo is theirs: it lives exactly as long as the job that
    // needed it, and this is the only thing that ends its life. Wrapped around
    // the whole queued job rather than sitting next to the turn, because the
    // job has four ways out — dropped as stale, refused by the vision gate,
    // answered, thrown — and three of them are not the turn returning.
    // Deleting a file the intake already removed is a no-op.
    try {
      return await queued;
    } finally {
      if (msg.image) await discardImages([msg.image.path]);
    }
  })
  .then((started) => log.info({ adapters: started }, 'adapters started'))
  .catch((e) => log.error({ err: e }, 'failed to start adapters'));

// Permission prompts go back to the chat that raised them — see the module
// header in bots/approval-bridge.ts for why the daemon was refusing commands
// the user's own policy said to ask about.
const detachApprovals = attachChatApprovals({
  manager,
  enabled: () => loadConfig().config.permissions.chatApprovals,
  // The transport has to answer before the policy's own timer denies it, so
  // it gets the configured window minus a couple of seconds of head start.
  timeoutMs: () => Math.max(5_000, loadConfig().config.permissions.timeoutSeconds * 1000 - 2_000),
  log: (fields, msg) => log.info(fields, msg),
});

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
    // Same session-aware resolution as the bot-turn path above, mirroring
    // how loadSouls is already applied uniformly to both. In practice a
    // `scheduled:<source>` session never has a style override on disk —
    // nothing writes one for that id, since /style only ever runs inside a
    // real chat's `bot:<chatId>` session — so this reduces to the daemon
    // default for cron/schedule runs today. Left uniform rather than
    // special-cased so the two dispatch paths can't quietly drift apart,
    // and so a scheduled run tied to a real chat id would pick up that
    // chat's own style for free if one is ever wired to it.
    const sStyle = resolveOutputStyle(session, sCfg.outputStyle);
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
  detachApprovals();
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
