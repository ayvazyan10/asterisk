// Asterisk configuration schemas. Persisted as ~/.asterisk/config.json.
// Secrets (API keys, bot tokens) live separately in ~/.asterisk/secrets.env.

import { z } from 'zod';

const ProviderSchema = z.enum(['ollama', 'anthropic']);

const OllamaSchema = z.object({
  baseUrl: z.string().url().default('http://127.0.0.1:11434'),
  model: z.string().default('qwen3.5:9b-q8-max'),
  contextWindow: z.number().int().positive().default(131072),
});

const AnthropicSchema = z.object({
  model: z.string().default('claude-3-5-haiku-latest'),
});

const TelegramSchema = z.object({
  enabled: z.boolean().default(false),
  allowedUserIds: z.array(z.number().int().positive()).default([]),
});

const WhatsappTransport = z.enum(['meta-cloud', 'web-js']);

const WhatsappMetaCloudSchema = z.object({
  phoneNumberId: z.string().default(''),
  businessAccountId: z.string().default(''),
  webhookPath: z.string().default('/whatsapp/webhook'),
  webhookPort: z.number().int().min(1).max(65535).default(8787),
});

const WhatsappWebJsSchema = z.object({
  sessionDir: z.string().default(''),
});

const WhatsappSchema = z.object({
  enabled: z.boolean().default(false),
  transport: WhatsappTransport.default('meta-cloud'),
  metaCloud: WhatsappMetaCloudSchema.default({}),
  webJs: WhatsappWebJsSchema.default({}),
});

const BotsSchema = z.object({
  telegram: TelegramSchema.default({}),
  whatsapp: WhatsappSchema.default({}),
});

const DaemonSchema = z.object({
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  heartbeatSeconds: z.number().int().min(5).default(60),
});

export const ConfigSchema = z.object({
  provider: ProviderSchema.default('ollama'),
  ollama: OllamaSchema.default({}),
  anthropic: AnthropicSchema.default({}),
  bots: BotsSchema.default({}),
  daemon: DaemonSchema.default({}),
});

export type AsteriskConfig = z.infer<typeof ConfigSchema>;

export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'ASTERISK_TELEGRAM_BOT_TOKEN',
  'ASTERISK_WHATSAPP_META_TOKEN',
  'ASTERISK_WHATSAPP_VERIFY_TOKEN',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
