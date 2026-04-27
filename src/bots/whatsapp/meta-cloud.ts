// WhatsApp Meta Cloud API adapter — official, ToS-compliant transport.
// Reference: https://developers.facebook.com/docs/whatsapp/cloud-api

import { createServer, type IncomingMessage as HttpIncoming, type ServerResponse } from 'node:http';

import type { BotAdapter, Handler, IncomingMessage } from '../adapter.ts';

export interface MetaCloudOptions {
  accessToken: string;
  verifyToken: string;
  phoneNumberId: string;
  webhookPath: string;
  webhookPort: number;
}

interface MetaWebhookEntry {
  changes?: Array<{
    value?: {
      messages?: Array<{
        from?: string;
        id?: string;
        timestamp?: string;
        type?: string;
        text?: { body?: string };
      }>;
    };
  }>;
}

interface MetaWebhookBody {
  entry?: MetaWebhookEntry[];
}

export function createWhatsappMetaCloudAdapter(opts: MetaCloudOptions): BotAdapter {
  if (!opts.accessToken) throw new Error('Meta Cloud adapter needs ASTERISK_WHATSAPP_META_TOKEN');
  if (!opts.verifyToken)
    throw new Error('Meta Cloud adapter needs ASTERISK_WHATSAPP_VERIFY_TOKEN');
  if (!opts.phoneNumberId) throw new Error('Meta Cloud adapter needs whatsapp.metaCloud.phoneNumberId');

  let server: ReturnType<typeof createServer> | undefined;

  return {
    name: 'whatsapp:meta-cloud',
    async start(handler: Handler): Promise<void> {
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (url.pathname !== opts.webhookPath) {
            return notFound(res);
          }
          if (req.method === 'GET') {
            return handleVerify(url, opts.verifyToken, res);
          }
          if (req.method === 'POST') {
            const body = await readJson(req);
            // Reply to Meta immediately; process the message in the background.
            res.statusCode = 200;
            res.end('ok');
            void processWebhook(body, opts, handler);
            return;
          }
          methodNotAllowed(res);
        } catch (e) {
          res.statusCode = 500;
          res.end((e as Error).message);
        }
      });
      await new Promise<void>((resolveStart) => {
        server?.listen(opts.webhookPort, () => resolveStart());
      });
    },
    async stop(): Promise<void> {
      if (!server) return;
      await new Promise<void>((r) => server?.close(() => r()));
    },
  };
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.end('not found');
}

function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.end('method not allowed');
}

function handleVerify(url: URL, expected: string, res: ServerResponse): void {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === expected && challenge) {
    res.statusCode = 200;
    res.end(challenge);
    return;
  }
  res.statusCode = 403;
  res.end('forbidden');
}

async function readJson(req: HttpIncoming): Promise<MetaWebhookBody> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as MetaWebhookBody) : {};
}

async function processWebhook(
  body: MetaWebhookBody,
  opts: MetaCloudOptions,
  handler: Handler,
): Promise<void> {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.type !== 'text' || !message.text?.body || !message.from) continue;
        const incoming: IncomingMessage = {
          chatId: message.from,
          userId: message.from,
          text: message.text.body,
          timestamp: Number(message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
        };
        try {
          const reply = await handler(incoming);
          await sendReply(opts, message.from, reply);
        } catch (e) {
          await sendReply(opts, message.from, `asterisk error: ${(e as Error).message}`).catch(
            () => {},
          );
        }
      }
    }
  }
}

async function sendReply(opts: MetaCloudOptions, to: string, text: string): Promise<void> {
  const url = `https://graph.facebook.com/v20.0/${opts.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text || '(empty)' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta Cloud send failed (${res.status}): ${body}`);
  }
}
