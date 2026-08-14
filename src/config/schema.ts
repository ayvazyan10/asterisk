// Asterisk configuration schemas. Persisted in ~/.asterisk/asterisk.db —
// scalars in the `settings` table, secrets in `secrets`, and the list-shaped
// fields (mcpServers, hooks) in tables of their own. `config.json` is only an
// import/export format now; see config/store.ts.
//
// The `.describe()` calls are not decoration: config/introspect.ts turns this
// schema into the web control panel's form, and these strings become its help
// text. Add a field here and it appears in the browser automatically.

import { z } from 'zod';

// `openai-compatible` is the universal local-model path — llama.cpp,
// LM Studio, vLLM, Jan, LocalAI, or any proxy speaking /v1/chat/completions.
// Ollama keeps a dedicated entry because Asterisk drives its native API.
const ProviderSchema = z.enum(['ollama', 'openai-compatible', 'anthropic']);

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

const OpenAiCompatibleSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .default('http://127.0.0.1:8080/v1')
    .describe('Endpoint root including the version segment, e.g. http://127.0.0.1:8080/v1'),
  model: z
    .string()
    .default('')
    .describe('Model id as the server reports it in /v1/models. Blank uses the server default.'),
  maxTokens: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .default(0)
    .describe('Cap on generated tokens. 0 lets the server decide.'),
  contextWindow: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .default(0)
    .describe(
      'Tokens the model can hold. Compaction budgets history against this; 0 falls back to a conservative default.',
    ),
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
  // Was `claude-3-5-haiku-latest` until 2026-07: Haiku 3.5 retired on
  // 2026-02-19, so that alias 404s. `claude-haiku-4-5` is its replacement.
  model: z
    .string()
    .default('claude-haiku-4-5')
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

const BotsSchema = z.object({
  telegram: TelegramSchema.default({}),
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

// Who may run what through the Bash tool. This is a consent boundary, not a
// sandbox: an approved command runs with the full privileges of the user who
// started Asterisk. See tools/bash-permissions.ts for the rule syntax.
const PermissionsSchema = z.object({
  mode: z
    .enum(['ask', 'allowlist', 'unrestricted'])
    .default('ask')
    .describe(
      'ask — run allowlisted commands, prompt for the rest. allowlist — refuse anything not allowlisted, never prompt. unrestricted — no boundary at all.',
    ),
  allow: z
    .array(z.string())
    .default([])
    .describe(
      'Extra rules that run without asking, on top of the built-in read-only set. Words are matched positionally against the command, e.g. "npm test" or "docker ps".',
    ),
  deny: z
    .array(z.string())
    .default([])
    .describe(
      'Rules that are refused outright, without a prompt. Overrides every allow rule, including the built-in ones.',
    ),
  headless: z
    .enum(['deny', 'allow'])
    .default('deny')
    .describe(
      'What to do when nobody can answer — the daemon and the bot bridges. "deny" keeps the boundary; "allow" removes it for every unattended run.',
    ),
  timeoutSeconds: z
    .number()
    .int()
    .min(5)
    .max(110)
    .default(90)
    .describe(
      'How long an approval prompt waits before refusing. Must stay under the agent loop tool deadline of 120s.',
    ),
});

// How far a shell command can reach once it is allowed to run. Distinct from
// `permissions`, which decides whether it runs at all: an approved command is
// still confined. Backed by bubblewrap on Linux and sandbox-exec on macOS, and
// neither is trusted until it has passed a containment probe on this machine.
const SandboxSchema = z.object({
  mode: z
    .enum(['auto', 'required', 'off'])
    .default('auto')
    .describe(
      'auto — confine commands when a working backend exists, run unconfined otherwise. required — refuse to run commands at all when none is available. off — never confine.',
    ),
  network: z
    .boolean()
    .default(true)
    .describe(
      'Let sandboxed commands reach the network. Turning this off blocks package installs, git push and curl along with everything else.',
    ),
  writablePaths: z
    .array(z.string())
    .default([])
    .describe(
      'Extra absolute paths a sandboxed command may write to, on top of the workspace and /tmp. Everything else on the filesystem is readable but read-only.',
    ),
});

// Whether the agent can see images, and how much context they may occupy.
// A screenshot costs well over a thousand tokens, so the caps matter as much
// as the switch.
const VisionSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .describe(
      'Send screenshots and other image attachments to the model. Turn off for a text-only model that errors on image input.',
    ),
  maxPerTurn: z
    .number()
    .int()
    .min(0)
    .max(8)
    .default(2)
    .describe('Most images attached to a single turn. Extra ones are named but not sent.'),
  maxBytes: z
    .number()
    .int()
    .min(0)
    .max(20_000_000)
    .default(4_000_000)
    .describe('Largest image that will be sent. Anything bigger is reported to the agent instead.'),
  keepInHistory: z
    .number()
    .int()
    .min(0)
    .max(8)
    .default(2)
    .describe(
      'How many of the most recent images stay in history. Older ones become a note — an old screenshot is rarely what the model needs.',
    ),
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

// `auth` decides how the request is authenticated:
//   none  — send `headers` and nothing else. A hand-pasted bearer token lives
//           here, which works until the day it expires and then fails with no
//           way to renew it.
//   oauth — a connector. Asterisk discovers the authorization server from the
//           401 the endpoint returns, registers itself dynamically, runs the
//           browser consent flow once, and refreshes the token from then on.
//           Linear, Notion, Atlassian and Sentry all work this way.
//   token — a connector authenticated by a token the user issues themselves.
//           GitHub is the reason this exists: its authorization server does
//           not offer dynamic client registration, so there is no way for
//           Asterisk to obtain a client id, and a personal access token is the
//           documented path instead.
//
// Both connector modes keep the credential in `mcp_credentials` and never in
// `headers` — a header is part of the exported configuration and a token must
// not be. `token` therefore is not the same as putting the token in `headers`
// by hand under `none`, which still works and still exports.
const McpHttpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
  auth: z.enum(['none', 'oauth', 'token']).default('none'),
  // Requested OAuth scopes. Empty means "ask for whatever the server
  // advertises as its default", which is what most connectors expect.
  scopes: z.array(z.string()).default([]),
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
  provider: ProviderSchema.default('ollama').describe('Which backend the agent loop talks to.'),
  providerFallback: z
    .array(ProviderSchema)
    .default([])
    .describe(
      'Backends to try, in order, when the primary one is unreachable. Only availability failures step down the chain — a rejected request is not retried elsewhere.',
    ),
  ollama: OllamaSchema.default({}),
  openaiCompatible: OpenAiCompatibleSchema.default({}),
  anthropic: AnthropicSchema.default({}),
  bots: BotsSchema.default({}),
  daemon: DaemonSchema.default({}),
  web: WebSchema.default({}),
  permissions: PermissionsSchema.default({}),
  sandbox: SandboxSchema.default({}),
  vision: VisionSchema.default({}),
  outputStyle: OutputStyleSchema.default('default').describe(
    'Behaviour modifier spliced into the system prompt.',
  ),
  mcpServers: z.array(McpServerSchema).default([]),
  hooks: z.array(HookConfigSchema).default([]),
});

export type AsteriskConfig = z.infer<typeof ConfigSchema>;

export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  // Only needed when the OpenAI-compatible endpoint is a hosted service;
  // local servers accept requests without one.
  'ASTERISK_OPENAI_API_KEY',
  'ASTERISK_TELEGRAM_BOT_TOKEN',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
