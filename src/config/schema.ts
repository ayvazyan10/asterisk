// Asterisk configuration schemas. Persisted in ~/.asterisk/asterisk.db —
// scalars in the `settings` table, secrets in `secrets`, and the list-shaped
// fields (mcpServers, hooks) in tables of their own. `config.json` is only an
// import/export format now; see config/store.ts.
//
// The `.describe()` calls are not decoration: config/introspect.ts turns this
// schema into the web control panel's form, and these strings become its help
// text. Add a field here and it appears in the browser automatically.

import { z } from 'zod';

const ProviderSchema = z.enum(['ollama', 'anthropic']);

const OllamaSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('http://127.0.0.1:11434')
    .describe('HTTP endpoint of the Ollama server.'),
  model: z
    .string()
    .default('carstenuhlig/omnicoder-9b:q8_0')
    .describe('Model tag to run, as shown by `ollama list`.'),
  contextWindow: z
    .number()
    .int()
    .positive()
    .default(65536)
    .describe('Tokens of context to request. Larger windows need more VRAM.'),
  think: z
    .boolean()
    .default(false)
    .describe('Ask the model for structured reasoning blocks before its answer.'),
  modelTimeoutMs: z
    .number()
    .int()
    .min(10000)
    .max(1800000)
    .default(300_000)
    .describe('Hard limit on a single generation before it is aborted.'),
  modelIdleTimeoutMs: z
    .number()
    .int()
    .min(5000)
    .max(300000)
    .default(90_000)
    .describe('Abort a generation that stops emitting tokens for this long.'),
});

const AnthropicSchema = z.object({
  model: z
    .string()
    .default('claude-3-5-haiku-latest')
    .describe('Anthropic model id. Requires ANTHROPIC_API_KEY.'),
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
  enabled: z.boolean().default(false).describe('Run the Telegram bridge when the daemon starts.'),
  allowedUserIds: z
    .array(z.number().int().positive())
    .default([])
    .describe('Numeric Telegram user ids allowed to talk to the bot. Empty means nobody.'),
  streamMode: TelegramStreamMode.default('final').describe(
    'final — one message at the end · status — live tool-use status · stream — progressive text.',
  ),
  streamThrottleMs: z
    .number()
    .int()
    .min(250)
    .max(10000)
    .default(1000)
    .describe('Minimum gap between message edits. Below ~1s Telegram starts rate-limiting.'),
  parseMode: TelegramParseMode.default('html').describe(
    'html renders markdown properly; plain shows the raw markers.',
  ),
});

const WhatsappTransport = z.enum(['meta-cloud', 'web-js']);

const WhatsappMetaCloudSchema = z.object({
  phoneNumberId: z.string().default('').describe('Phone number id from the Meta app dashboard.'),
  businessAccountId: z.string().default('').describe('WhatsApp Business Account id.'),
  webhookPath: z.string().default('/whatsapp/webhook').describe('Path Meta posts webhooks to.'),
  webhookPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(8787)
    .describe('Local port the webhook listener binds to.'),
});

const WhatsappWebJsSchema = z.object({
  sessionDir: z
    .string()
    .default('')
    .describe('Where the linked-device session is cached. Blank uses ~/.asterisk/whatsapp-web-session.'),
});

const WhatsappSchema = z.object({
  enabled: z.boolean().default(false).describe('Run the WhatsApp bridge when the daemon starts.'),
  transport: WhatsappTransport.default('meta-cloud').describe(
    'meta-cloud uses the official Business API; web-js drives a linked WhatsApp Web session.',
  ),
  metaCloud: WhatsappMetaCloudSchema.default({}),
  webJs: WhatsappWebJsSchema.default({}),
});

const BotsSchema = z.object({
  telegram: TelegramSchema.default({}),
  whatsapp: WhatsappSchema.default({}),
});

const DaemonSchema = z.object({
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info')
    .describe('Verbosity of ~/.asterisk/logs/daemon.log.'),
  heartbeatSeconds: z
    .number()
    .int()
    .min(5)
    .default(60)
    .describe('How often the daemon writes a liveness record.'),
});

// The web control panel. Off unless started explicitly via `asterisk web`;
// these values are its defaults when no flag overrides them.
const WebSchema = z.object({
  host: z
    .string()
    .default('127.0.0.1')
    .describe('Interface to bind. Leave on loopback unless you front it with a TLS proxy.'),
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4321)
    .describe('Port the control panel listens on.'),
  authRequired: z
    .boolean()
    .default(true)
    .describe('Require a token. Only safe to disable on a loopback bind you fully trust.'),
  openBrowser: z
    .boolean()
    .default(true)
    .describe('Open the panel in the default browser on start.'),
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
  provider: ProviderSchema.default('ollama').describe(
    'Which backend the agent loop talks to.',
  ),
  ollama: OllamaSchema.default({}),
  anthropic: AnthropicSchema.default({}),
  bots: BotsSchema.default({}),
  daemon: DaemonSchema.default({}),
  web: WebSchema.default({}),
  outputStyle: OutputStyleSchema.default('default').describe(
    'Behaviour modifier spliced into the system prompt.',
  ),
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
