// Bot adapter contract — every transport (Telegram, WhatsApp, ...) implements
// this interface so the daemon can spin them up uniformly.

export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
}

export type Handler = (msg: IncomingMessage) => Promise<string>;

export interface BotAdapter {
  name: string;
  start(handler: Handler): Promise<void>;
  stop(): Promise<void>;
}
