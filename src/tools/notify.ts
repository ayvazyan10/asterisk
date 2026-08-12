// Notification + remote-trigger tools.
//
// PushNotification posts a short message to a configured webhook URL (the
// canonical way to ping the user out-of-band: ntfy.sh, Slack/Discord
// webhook, custom endpoint).
//
// RemoteTrigger is a small generic HTTP POST tool with arbitrary URL,
// headers, and JSON/form body — for when the agent needs to fire something
// off to a third-party API the user trusts.

import { request } from 'undici';

import { type Tool, err, ok } from './types.ts';

const TIMEOUT_MS = 10_000;

export const pushNotificationTool: Tool = {
  name: 'PushNotification',
  description:
    'Send a short notification to the user out-of-band. Targets a webhook URL configured via $ASTERISK_NOTIFY_URL (or the `url` arg). Compatible with ntfy.sh, Slack/Discord incoming webhooks, and any JSON receiver.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional short title.' },
      message: { type: 'string', description: 'Body of the notification.' },
      url: {
        type: 'string',
        description: 'Override the webhook URL (default $ASTERISK_NOTIFY_URL).',
      },
      priority: {
        type: 'string',
        description: 'Optional severity: low | normal | high (default normal).',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  async execute(input) {
    const message = typeof input['message'] === 'string' ? input['message'].trim() : '';
    if (!message) return err('message is required');
    const url =
      (typeof input['url'] === 'string' && input['url'].trim()) ||
      process.env['ASTERISK_NOTIFY_URL'];
    if (!url) return err('no webhook URL — pass `url` or set ASTERISK_NOTIFY_URL');
    const title = typeof input['title'] === 'string' ? input['title'] : 'Asterisk';
    const priority = typeof input['priority'] === 'string' ? input['priority'] : 'normal';

    const body = JSON.stringify({ title, message, priority, source: 'asterisk' });
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-asterisk-priority': priority,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.statusCode >= 400) {
        const t = await res.body.text();
        return err(`webhook HTTP ${res.statusCode}: ${t.slice(0, 200)}`);
      }
      return ok(`✓ notified · ${url}`);
    } catch (e) {
      return err(`PushNotification failed: ${(e as Error).message}`);
    }
  },
};

export const remoteTriggerTool: Tool = {
  name: 'RemoteTrigger',
  description:
    'Fire a generic HTTP request (POST by default) at a third-party endpoint. Use when the agent needs to trigger an external system (CI, webhook, IFTTT, n8n, …). Returns status + first 1k chars of response body.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      method: { type: 'string', description: 'HTTP method (default POST).' },
      headers: {
        type: 'object',
        description: 'Optional request headers (string → string).',
        additionalProperties: { type: 'string' },
      },
      bodyJson: { type: 'object', description: 'JSON body — sent as application/json.' },
      bodyText: {
        type: 'string',
        description: 'Raw text body (mutually exclusive with bodyJson).',
      },
      timeoutMs: { type: 'number', description: 'Network timeout (default 10000).' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(input) {
    const url = typeof input['url'] === 'string' ? input['url'] : '';
    if (!url || !/^https?:\/\//i.test(url)) return err('valid http(s) url required');
    const method = (typeof input['method'] === 'string' && input['method']) || 'POST';
    const timeoutMs = typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : TIMEOUT_MS;
    const headers: Record<string, string> = {};
    if (input['headers'] && typeof input['headers'] === 'object') {
      for (const [k, v] of Object.entries(input['headers'])) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
    }
    let body: string | undefined;
    if (input['bodyJson'] && typeof input['bodyJson'] === 'object') {
      body = JSON.stringify(input['bodyJson']);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    } else if (typeof input['bodyText'] === 'string') {
      body = input['bodyText'];
    }

    try {
      const reqInit: Parameters<typeof request>[1] = {
        method: method.toUpperCase() as 'POST',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body !== undefined) reqInit.body = body;
      const res = await request(url, reqInit);
      const text = await res.body.text();
      const trimmed = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
      return ok(`HTTP ${res.statusCode} · ${url}\n---\n${trimmed}`);
    } catch (e) {
      return err(`RemoteTrigger failed: ${(e as Error).message}`);
    }
  },
};

export const NOTIFY_TOOLS: Tool[] = [pushNotificationTool, remoteTriggerTool];
