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

// Telegram streaming modes — Telegram has no native server-sent events for
// bots, so "streaming" here means progressively editing a placeholder
// message via editMessageText (rate-limited to ~1 edit/sec/chat per the
// Bot API guidelines). Reference: https://core.telegram.org/bots/api#editmessagetext
//   final  — single message at end of turn (cheapest, current default)
//   status — placeholder updated with tool-use status; final reply replaces it
//   stream — placeholder progressively edited with the model's text as it arrives
export const TelegramStreamMode = z.enum(['final', 'status', 'stream']);
export type TelegramStreamModeT = z.infer<typeof TelegramStreamMode>;

// Parse mode: how the agent's reply text is rendered in Telegram.
//   plain — exactly what the agent emitted, no formatting (markdown
//           markers visible as literal text — *not* what most users want)
//   html  — markdown converted to Telegram HTML so **bold**, *italic*,
//           `code`, fenced code blocks, links, etc. render properly.
//           Reference: https://core.telegram.org/bots/api#html-style
export const TelegramParseMode = z.enum(['plain', 'html']);
export type TelegramParseModeT = z.infer<typeof TelegramParseMode>;

const TelegramSchema = z.object({
  enabled: z.boolean().default(false),
  allowedUserIds: z.array(z.number().int().positive()).default([]),
  streamMode: TelegramStreamMode.default('final'),
  streamThrottleMs: z.number().int().min(250).max(10000).default(1000),
  parseMode: TelegramParseMode.default('html'),
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

// Hooks fire at agent-loop lifecycle events. Each hook is a shell command
// run with the event payload on stdin (JSON). Stdout is logged into the
// transcript as a system note; non-zero exit logs the stderr too.
export const HookEventSchema = z.enum([
  'before_turn',
  'after_turn',
  'before_tool',
  'after_tool',
  'on_error',
]);
export type HookEvent = z.infer<typeof HookEventSchema>;

export const HookConfigSchema = z.object({
  name: z.string().min(1),
  event: HookEventSchema,
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  enabled: z.boolean().default(true),
});
export type HookConfig = z.infer<typeof HookConfigSchema>;

// MCP server entry — either stdio (spawned subprocess) or http (Streamable
// HTTP endpoint). Reference: https://modelcontextprotocol.io/specification
const McpStdioServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

const McpHttpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export const McpServerSchema = z.discriminatedUnion('transport', [
  McpStdioServerSchema,
  McpHttpServerSchema,
]);

export type McpServerConfig = z.infer<typeof McpServerSchema>;

// Output style — global behaviour modifier spliced into the system prompt.
//   default     — baseline, no extra instructions (current behaviour)
//   concise     — trim every reply to the minimum
//   explanatory — show reasoning + tradeoffs alongside the answer
//   learning    — collaborative, ask the user to pick on non-trivial decisions
export const OutputStyleSchema = z.enum(['default', 'concise', 'explanatory', 'learning']);

export const ConfigSchema = z.object({
  provider: ProviderSchema.default('ollama'),
  ollama: OllamaSchema.default({}),
  anthropic: AnthropicSchema.default({}),
  bots: BotsSchema.default({}),
  daemon: DaemonSchema.default({}),
  outputStyle: OutputStyleSchema.default('default'),
  mcpServers: z.array(McpServerSchema).default([]),
  hooks: z.array(HookConfigSchema).default([]),
});

export type AsteriskConfig = z.infer<typeof ConfigSchema>;

export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'ASTERISK_TELEGRAM_BOT_TOKEN',
  'ASTERISK_WHATSAPP_META_TOKEN',
  'ASTERISK_WHATSAPP_VERIFY_TOKEN',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
