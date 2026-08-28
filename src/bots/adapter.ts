// Bot adapter contract — every transport implements this interface so the
// daemon can spin them up uniformly.

import type { ApprovalOutcome } from '../tools/approval.ts';

export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  /**
   * A voice message the transport downloaded, for the core to transcribe.
   *
   * The transport does not transcribe it itself: which backend runs, whether
   * transcription is on at all, and what the agent is told when it fails are
   * policy, and policy does not belong in a protocol adapter. The file is
   * temporary — the handler owns it and deletes it when the turn is done.
   */
  voice?: {
    path: string;
    /** Length reported by the transport, for the message the agent sees. */
    seconds?: number;
  };
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document';

export interface Attachment {
  kind: AttachmentKind;
  /** Absolute or cwd-relative path to the file on disk. */
  path: string;
  caption?: string;
}

export interface OutgoingMessage {
  text: string;
  attachments?: Attachment[];
}

/** Adapters that support progressive delivery (e.g. Telegram editMessageText)
 *  pass a StreamSink into the handler so it can emit status / partial-text
 *  events while the agent loop runs. Adapters that don't (the REPL) simply omit
 *  the sink and consume the handler's eventual return value. */
export type StreamEvent =
  /** Tool calls, retries, etc. — short single-line summary. */
  | { type: 'status'; text: string }
  /** Streaming token / delta as the model produces it. Streaming-aware
   *  providers fire many of these per turn. */
  | { type: 'text'; text: string }
  /** Whole text block delivered at the end of a model turn. Adapters can
   *  use this when the provider didn't stream (so no 'text' events fired). */
  | { type: 'text-final'; text: string }
  /** Turn finished. The handler's resolved value carries the canonical
   *  reply; this event lets adapters know to flush + finalise their UI. */
  | { type: 'final' };

export type StreamSink = (e: StreamEvent) => void;

export interface HandlerOptions {
  sink?: StreamSink;
}

/** Handlers may return a plain string (text-only reply) or an OutgoingMessage
 *  with attachments. The adapter sends the text and each attachment in turn. */
export type Handler = (
  msg: IncomingMessage,
  opts?: HandlerOptions,
) => Promise<string | OutgoingMessage>;

/** A permission question posed to the chat that raised it. */
export interface ApprovalPrompt {
  /** The command the model wants to run. */
  command: string;
  /** Why the policy could not settle it alone. */
  reason: string;
  /** What "always allow" would remember, so the scope of that answer is visible. */
  rules: readonly string[];
  /** Answer by then or don't bother: the agent loop has already given up. */
  timeoutMs: number;
}

export interface BotAdapter {
  name: string;
  start(handler: Handler): Promise<void>;
  stop(): Promise<void>;
  /**
   * Asks the chat whether a command may run, if the transport can render a
   * choice. Optional on purpose: a transport without it is genuinely
   * unattended, and the policy falls back to `permissions.headless` rather
   * than pretending someone was asked.
   *
   * Must resolve within `timeoutMs` and must never reject — a transport error
   * is a denial, not a tool crash.
   */
  promptApproval?(chatId: string, prompt: ApprovalPrompt): Promise<ApprovalOutcome>;
  /**
   * Withdraws the permission questions still open in one chat, returning how
   * many there were. Used by /stop: aborting the turn frees the tool side at
   * once, but the question the transport rendered is its own object and would
   * otherwise sit there with live buttons until its timer ran out.
   *
   * Optional for the same reason `promptApproval` is — a transport that never
   * asks has nothing to withdraw.
   */
  cancelApprovals?(chatId: string): number;
}

export function asOutgoingMessage(r: string | OutgoingMessage): OutgoingMessage {
  return typeof r === 'string' ? { text: r } : r;
}

const EXT_TO_KIND: Record<string, AttachmentKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
};

export function inferAttachmentKind(path: string): AttachmentKind {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'document';
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_TO_KIND[ext] ?? 'document';
}
