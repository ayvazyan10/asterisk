// WhatsApp web-js adapter — uses whatsapp-web.js to drive WhatsApp Web via
// puppeteer. Unofficial; **violates WhatsApp Terms of Service**; risks number
// bans. Personal-use only. Users must opt in explicitly via configure.
//
// Reference: https://github.com/pedroslopez/whatsapp-web.js

import {
  type Attachment,
  type BotAdapter,
  type Handler,
  type IncomingMessage,
  asOutgoingMessage,
} from '../adapter.ts';

export interface WebJsOptions {
  sessionDir: string;
}

interface WhatsappWebMessage {
  from: string;
  body: string;
  fromMe: boolean;
  reply(text: string): Promise<unknown>;
}

type WhatsappWebMessageMedia = {};

interface WhatsappWebClient {
  on(event: 'qr', cb: (qr: string) => void): void;
  on(event: 'ready', cb: () => void): void;
  on(event: 'message', cb: (msg: WhatsappWebMessage) => void): void;
  sendMessage(
    chatId: string,
    content: string | WhatsappWebMessageMedia,
    options?: { caption?: string; sendMediaAsDocument?: boolean },
  ): Promise<unknown>;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}

export function createWhatsappWebJsAdapter(opts: WebJsOptions): BotAdapter {
  let client: WhatsappWebClient | undefined;

  return {
    name: 'whatsapp:web-js',
    async start(handler: Handler): Promise<void> {
      // Lazy import — keep the heavy puppeteer dep off the cold-start path
      // when this transport isn't used.
      const mod = (await import('whatsapp-web.js')) as unknown as {
        Client: new (opts: { authStrategy?: unknown }) => WhatsappWebClient;
        LocalAuth: new (opts: { dataPath: string }) => unknown;
        MessageMedia: { fromFilePath(path: string): WhatsappWebMessageMedia };
      };

      client = new mod.Client({
        authStrategy: new mod.LocalAuth({ dataPath: opts.sessionDir }),
      });

      const sendAttachment = async (chatId: string, a: Attachment): Promise<void> => {
        if (!client) return;
        const media = mod.MessageMedia.fromFilePath(a.path);
        const sendOpts: { caption?: string; sendMediaAsDocument?: boolean } = {};
        if (a.caption !== undefined) sendOpts.caption = a.caption;
        if (a.kind === 'document') sendOpts.sendMediaAsDocument = true;
        await client.sendMessage(chatId, media, sendOpts);
      };

      client.on('qr', (qr) => {
        process.stderr.write(
          `\n[asterisk-whatsapp] scan this QR with WhatsApp -> Linked Devices:\n${qr}\n\n`,
        );
      });
      client.on('ready', () => {
        process.stderr.write('[asterisk-whatsapp] web-js ready\n');
      });
      client.on('message', async (msg: WhatsappWebMessage) => {
        if (msg.fromMe) return;
        const incoming: IncomingMessage = {
          chatId: msg.from,
          userId: msg.from,
          text: msg.body,
          timestamp: Date.now(),
        };
        try {
          const result = await handler(incoming);
          const out = asOutgoingMessage(result);
          if (out.text) await msg.reply(out.text);
          for (const a of out.attachments ?? []) {
            try {
              await sendAttachment(msg.from, a);
            } catch (sendErr) {
              await msg
                .reply(`(failed to send ${a.kind} ${a.path}: ${(sendErr as Error).message})`)
                .catch(() => {});
            }
          }
        } catch (e) {
          await msg.reply(`asterisk error: ${(e as Error).message}`).catch(() => {});
        }
      });

      await client.initialize();
    },
    async stop(): Promise<void> {
      if (!client) return;
      await client.destroy();
    },
  };
}
