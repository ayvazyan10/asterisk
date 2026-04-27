// Bot adapter contract — every transport (Telegram, WhatsApp, …) implements
// this interface so the daemon can spin them up uniformly.

export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
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
 *  events while the agent loop runs. Adapters that don't (REPL, WhatsApp web-js)
 *  simply omit the sink and consume the handler's eventual return value. */
export type StreamEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; text: string }
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

export interface BotAdapter {
  name: string;
  start(handler: Handler): Promise<void>;
  stop(): Promise<void>;
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
