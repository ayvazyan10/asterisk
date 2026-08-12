// WhatsApp Meta Cloud API adapter — official, ToS-compliant transport.
// Reference: https://developers.facebook.com/docs/whatsapp/cloud-api

import { createReadStream } from 'node:fs';
import { type IncomingMessage as HttpIncoming, type ServerResponse, createServer } from 'node:http';
import { basename } from 'node:path';

import {
  type Attachment,
  type BotAdapter,
  type Handler,
  type IncomingMessage,
  asOutgoingMessage,
} from '../adapter.ts';

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
  if (!opts.verifyToken) throw new Error('Meta Cloud adapter needs ASTERISK_WHATSAPP_VERIFY_TOKEN');
  if (!opts.phoneNumberId)
    throw new Error('Meta Cloud adapter needs whatsapp.metaCloud.phoneNumberId');

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
          const result = await handler(incoming);
          const out = asOutgoingMessage(result);
          if (out.text) await sendText(opts, message.from, out.text);
          for (const a of out.attachments ?? []) {
            try {
              await sendMedia(opts, message.from, a);
            } catch (sendErr) {
              await sendText(
                opts,
                message.from,
                `(failed to send ${a.kind} ${a.path}: ${(sendErr as Error).message})`,
              ).catch(() => {});
            }
          }
        } catch (e) {
          await sendText(opts, message.from, `asterisk error: ${(e as Error).message}`).catch(
            () => {},
          );
        }
      }
    }
  }
}

async function sendText(opts: MetaCloudOptions, to: string, text: string): Promise<void> {
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

// Two-step media send: upload the file to /media to get an id, then send
// a message that references it. Mirrors the Meta Cloud Media API:
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
async function sendMedia(opts: MetaCloudOptions, to: string, a: Attachment): Promise<void> {
  const id = await uploadMedia(opts, a);
  const url = `https://graph.facebook.com/v20.0/${opts.phoneNumberId}/messages`;
  const payloadKey =
    a.kind === 'image'
      ? 'image'
      : a.kind === 'video'
        ? 'video'
        : a.kind === 'audio'
          ? 'audio'
          : 'document';
  const mediaPayload: Record<string, unknown> = { id };
  if (
    a.caption &&
    (payloadKey === 'image' || payloadKey === 'video' || payloadKey === 'document')
  ) {
    mediaPayload['caption'] = a.caption;
  }
  if (payloadKey === 'document') mediaPayload['filename'] = basename(a.path);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: payloadKey,
      [payloadKey]: mediaPayload,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta Cloud media-send failed (${res.status}): ${body}`);
  }
}

async function uploadMedia(opts: MetaCloudOptions, a: Attachment): Promise<string> {
  const url = `https://graph.facebook.com/v20.0/${opts.phoneNumberId}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeFor(a));
  // Bun's FormData supports Blob; build one from the file stream-as-buffer.
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(a.path);
  form.append('file', new Blob([new Uint8Array(buf)], { type: mimeFor(a) }), basename(a.path));
  // Suppress unused — createReadStream stays imported for future streaming
  void createReadStream;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.accessToken}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta Cloud media-upload failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('Meta Cloud upload returned no id');
  return data.id;
}

function mimeFor(a: Attachment): string {
  const ext = a.path.toLowerCase().split('.').pop() ?? '';
  if (a.kind === 'image') {
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    return 'image/jpeg';
  }
  if (a.kind === 'video') return ext === 'mp4' ? 'video/mp4' : 'video/mp4';
  if (a.kind === 'audio') {
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'ogg') return 'audio/ogg';
    if (ext === 'm4a') return 'audio/mp4';
    return 'audio/mpeg';
  }
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'txt') return 'text/plain';
  return 'application/octet-stream';
}
