# Asterisk

A lightweight, personal AI assistant. Asterisk gives you an interactive
agent in your terminal and an optional long-running daemon that bridges the
same assistant to Telegram and WhatsApp.

- **Local by default** — talks to a local [Ollama](https://ollama.com) model
  out of the box; the public `@anthropic-ai/sdk` is wired in as an opt-in
  alternative.
- **Real tools** — filesystem, shell, web, **a real Chromium browser via
  Playwright**, MCP-server integration, sub-agents, scheduled and recurring
  prompts, and more.
- **No telemetry, no cloud control plane.** Everything runs on your machine.
- **Built on documented APIs** — Anthropic Messages + tool-use loop, Ollama
  HTTP, Telegram Bot API ([grammY](https://grammy.dev)), WhatsApp Meta Cloud
  API, [Model Context Protocol](https://modelcontextprotocol.io), Playwright.
- **Apache 2.0** licensed.

Status `0.1.0` — early but real. ~30 built-in tools, 15 slash commands,
14 daemon-managed scheduling/lifecycle features, 5 bundled skills, and a
SOUL.md persona system that bot users can manage per-chat.

## Install

One-line install (macOS / Linux / WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/install.sh | bash
```

The installer:

1. Installs [Bun](https://bun.sh) ≥ 1.2 if it isn't already on your machine.
2. Clones Asterisk into `~/.local/share/asterisk`.
3. Builds `dist/`.
4. Downloads Chromium for Playwright (~150 MB; skip with `ASTERISK_SKIP_BROWSERS=1`).
5. Symlinks `~/.local/bin/asterisk` so the `asterisk` command is on your PATH.

Override locations or branch via env vars on the receiving `bash`:

```bash
curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/install.sh \
  | ASTERISK_INSTALL_DIR=/opt/asterisk ASTERISK_BIN_DIR=/usr/local/bin bash
```

Available: `ASTERISK_INSTALL_DIR` (default `~/.local/share/asterisk`),
`ASTERISK_BIN_DIR` (default `~/.local/bin`), `ASTERISK_BRANCH` (default
`master`), `ASTERISK_REPO_URL`, `ASTERISK_SKIP_BROWSERS`.

To uninstall:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/uninstall.sh)
```

Your `~/.asterisk/` config is preserved unless you delete it explicitly.

### From source

```bash
git clone https://github.com/ayvazyan10/asterisk.git && cd asterisk
bun install
bun playwright install chromium    # optional — only if you want browser tools
bun run build
./bin/asterisk help
```

## Quick start

Requirements:

- [Bun](https://bun.sh) ≥ 1.2 (handled by the installer).
- An Ollama server reachable from this machine, OR an `ANTHROPIC_API_KEY`.

```bash
asterisk                # interactive REPL
asterisk start          # daemon mode (Telegram / WhatsApp bridges)
asterisk status         # daemon pid + log size
asterisk logs 100
asterisk restart
asterisk stop
asterisk configure      # interactive wizard for provider + bots + MCP
asterisk help
```

## REPL highlights

- Type `/` and a filtered command picker pops up — `↑↓` navigate, `Tab`
  completes, `Enter` runs, `Esc` clears.
- Slash commands open **forms** for fields and **list pickers** for choices,
  not CLI args. Ask the agent to add an MCP server and it walks you through
  a transport-pick → form flow.
- Long tool output is collapsed by default with `[+N more lines · Ctrl+O to expand]`.
- The thinking indicator sits **above** the input, not inside it — you can
  type a side question while the agent works; it gets queued and runs after
  the current turn.
- Markdown rendered: `**bold**`, `*italic*`, `` `code` ``, fenced code blocks,
  bullets, headers, blockquotes — all properly indented under the cyan
  assistant marker.
- Screenshots render inline on iTerm2 / WezTerm / Kitty; on other terminals
  the `file://` URL is clickable and `open: true` launches the OS viewer.

## Slash commands

| Command            | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `/help [name]`     | List commands or show details for one                       |
| `/clear`           | Forget the current conversation history                     |
| `/model [name]`    | List installed models or switch the active one              |
| `/provider [name]` | Switch between `ollama` and `anthropic` at runtime          |
| `/tools`           | List registered tools (built-ins + MCP)                     |
| `/status`          | Live runtime view: provider, bots, MCP, daemon              |
| `/config`          | Interactive forms for each config section                   |
| `/reset`           | Clear history and rebuild the provider from config          |
| `/mcp`             | Manage MCP servers — list/add/edit/remove/reload (visual)   |
| `/rules`           | List the rules currently loaded into the system prompt      |
| `/skills`          | List installed skills (bundled + user + project)            |
| `/skill [name]`    | Run a skill — picker if no name given                       |
| `/soul [verb]`     | Show / `init` / `where` your SOUL.md persona                |
| `/hooks`           | Manage agent-loop lifecycle hooks (visual)                  |
| `/quit`            | Exit the REPL                                               |

## Built-in tools

The agent has these tools out of the box:

**Filesystem & shell**
`Bash` · `Read` · `Write` · `Edit` · `Grep` · `Glob`

**Browser (real Chromium via Playwright)**
`BrowserNavigate` · `BrowserClick` · `BrowserType` · `BrowserPress` ·
`BrowserSnapshot` · `BrowserScreenshot` · `BrowserWait` · `BrowserClose`

**Web research**
`WebFetch` (URL → readable text) · `WebSearch` (Brave / Tavily / SearXNG /
DDG instant-answer, picks the first backend you've configured a key for)

**Planning**
`TaskCreate` · `TaskUpdate` · `TaskList` · `TaskGet` · `TaskStop` — the
agent's own todo list, used to track multi-step work.

**Plan Mode**
`EnterPlanMode` / `ExitPlanMode` — toggle a flag that hides write tools so
the agent can only research.

**Delegation**
`Agent` — spawn a sub-agent in an isolated conversation for focused
research or parallel investigation.

**Worktree**
`EnterWorktree` / `ExitWorktree` — create / remove a `git worktree` for
risky changes that shouldn't touch the active branch.

**Monitoring & notifications**
`Monitor` (start/tail/stop background commands) · `PushNotification`
(webhook out-of-band) · `RemoteTrigger` (generic HTTP request).

**Interactive**
`AskUserQuestion` — pause the loop and ask the user a question with
free-text or a list-picker; user's answer resolves the tool.

**Scheduling** (daemon-managed)
`ScheduleWakeup` (one-shot delay) · `CronCreate` / `CronDelete` / `CronList`
(5-field cron expressions). The daemon polls every 30s and dispatches due
items as fresh agent turns.

Plus any tools exposed by configured MCP servers, namespaced as
`<servername>__<toolname>`.

## Skills, rules, hooks, souls

**Skills** — reusable workflows. 5 bundled out of the box:

- `simplify` — review your recent changes for reuse / quality / efficiency
- `batch` — apply one operation across many targets, with progress tracking
- `stuck` — diagnose why a task is blocked, propose alternatives
- `dream` — free-form roam, find one improvement worth making
- `skillify` — capture the current conversation as a new SKILL.md

Add your own at `~/.asterisk/skills/<name>/SKILL.md` (user-global) or
`<repo>/.asterisk/skills/<name>/SKILL.md` (project-local). User/project
skills override bundled ones with the same name.

**Rules** — markdown auto-loaded into the system prompt:

- `~/.asterisk/rules/*.md` — user-global (e.g. tone, coding style)
- `<repo>/.asterisk/rules/*.md` — project-local
- `<repo>/ASTERISK.md` — project root marker

**Hooks** — shell commands fired at agent-loop lifecycle events
(`before_turn`, `after_turn`, `before_tool`, `after_tool`, `on_error`).
Configured via `/hooks` (visual). The hook command receives the event
payload as JSON on stdin; stdout is surfaced as a system note in the
transcript.

**Souls** — `SOUL.md` describes who the assistant should be and who it's
talking to. Spliced into the system prompt before rules. Three layers,
all optional, later wins on conflict:

- `~/.asterisk/SOUL.md` — operator persona (applies everywhere)
- `~/.asterisk/souls/<scope>-<sid>.md` — **per-chat** persona; written by
  Telegram / WhatsApp users via `/soul set <text>`, so each chat owns its
  own description without affecting anyone else
- `<repo>/.asterisk/SOUL.md` or `<repo>/SOUL.md` — project-local persona

In the REPL: `/soul` shows what's loaded, `/soul init` drops a starter
template at `~/.asterisk/SOUL.md`, `/soul where` lists the search paths.

In Telegram / WhatsApp: `/soul`, `/soul set <multi-line markdown>`,
`/soul edit`, `/soul clear`, `/soul help` — all scoped to the current
chat. `/soul set Call me Levon, reply in Russian, skip apologies` is
enough to teach the bot a new persona for that chat alone.

## Bot transports

| Transport            | Status                | Notes                                              |
| -------------------- | --------------------- | -------------------------------------------------- |
| Telegram (grammY)    | Recommended           | Bot token from @BotFather; allowlist required.     |
| WhatsApp Meta Cloud  | Recommended           | ToS-compliant; needs Meta Business Manager setup.  |
| WhatsApp web-js      | **Personal use only** | Drives WhatsApp Web via Puppeteer. Violates WhatsApp ToS. Risks number bans. |

All bot writes are gated by config — no transport runs unless you explicitly
enable it via `asterisk configure`. Both bots can also send media: any
attachment the agent emits via the `Attach` tool (image, video, audio,
document) is delivered as a real Telegram / WhatsApp media message.

**Telegram reply modes** (`bots.telegram.streamMode`):

- `final` *(default)* — one message at the end of the turn. Cheapest, no
  edit churn, identical to a typical chat reply.
- `status` — sends a `◐ working…` placeholder, edits it with live
  tool-call status (`BrowserNavigate · https://wttr.in/...`,
  `WebFetch · https://...`), and replaces it with the final reply when
  the turn ends. Good for visibility into long-running tool chains.
- `stream` — placeholder is progressively edited with the model's text
  as it arrives, so the reply types itself out in front of the user.
  Active tool calls surface as a faded tail line under the streaming
  text.

Telegram's Bot API rate-limits edits to ~1/sec/chat; `streamThrottleMs`
(default 1000) coalesces rapid updates so we stay under the limit.
WhatsApp transports don't expose `editMessageText`, so this knob is
Telegram-only — WhatsApp always uses the equivalent of `final` mode.

**Text formatting** (`bots.telegram.parseMode`):

- `html` *(default)* — the agent's markdown is converted to Telegram HTML
  on the way out, so `**bold**`, `*italic*`, `` `code` ``, fenced code
  blocks, `[links](https://…)`, headings, bullets and `> quotes` all
  render as the user expects. Mid-stream tag balancing keeps live edits
  valid; if Telegram still rejects the markup we silently fall back to
  plain text rather than dropping the reply.
- `plain` — send exactly what the agent emits. Use this if you want the
  raw markdown markers visible (debugging, or if your persona instructs
  the model to avoid markup entirely).

**Per-user isolation.** Each chat — Telegram chatId, WhatsApp number, or
the local REPL — gets its own task list, plan-mode flag, browser context,
monitored processes, and SOUL.md persona. Two users sharing a daemon
never see each other's state.

**Bot-side slash commands** (auto-completed in Telegram via
`setMyCommands`):

| Command  | What it does                                              |
| -------- | --------------------------------------------------------- |
| `/help`  | How to use the bot                                        |
| `/status`| Provider, model, your tasks, plan mode, worktree          |
| `/clear` | Forget conversation history                               |
| `/reset` | Clear history + tasks + plan mode                         |
| `/tasks` | List your tasks                                           |
| `/plan`  | Toggle Plan Mode (read-only research mode)                |
| `/soul`  | Show / `set` / `edit` / `clear` your personal persona     |

## MCP servers

Asterisk speaks the [Model Context Protocol](https://modelcontextprotocol.io)
as a **client**. Add servers via `/mcp` (or hand-edit
`~/.asterisk/config.json` `mcpServers[]`):

- **stdio**: `{ name, transport: "stdio", command, args, env }`
- **http**: `{ name, transport: "http", url, headers }`

Tools exposed by connected MCP servers are namespaced as
`<servername>__<toolname>` and added to the agent's tool registry on
startup. Failures during connect surface in `/mcp list`, never crash
startup.

## Architecture

```
bin/asterisk         # Bash dispatcher: REPL | start | stop | status | logs | configure
src/
├── entrypoints/     # cli.tsx · daemon.ts · control.ts · configure.tsx
├── repl/            # Ink REPL — App, CommandMenu, MarkdownText,
│                    # WorkingIndicator, forms/, inline-image
├── agent/loop.ts    # tool-use loop with retry, abort, terminal-reason,
│                    # rules, hooks, sub-agents, per-tool timeout
├── providers/       # ollama (default) · anthropic · errors (ProviderError)
├── tools/           # bash · read · write · edit · grep · glob ·
│                    # browser/ (Playwright) · webfetch · websearch ·
│                    # tasks · subagent · planmode · worktree · notify ·
│                    # monitor · ask · schedule
├── commands/        # slash command registry (visual flows)
├── config/          # zod schema · loader · interactive wizard
├── daemon/          # pidfile · logger · lifecycle · scheduler
├── bots/            # adapter contract · telegram · whatsapp/{meta-cloud, web-js}
├── mcp/             # client · manager (stdio + Streamable HTTP)
├── hooks/runner.ts  # lifecycle hooks (before/after_tool, …)
├── rules/loader.ts  # markdown rules → system prompt
├── skills/          # bundled.ts (5) + loader (user/project SKILL.md)
├── soul/loader.ts   # SOUL.md (user / per-chat / project) → system prompt
├── agent/context.ts # per-session ALS — chatId scopes tasks/plan/soul/etc
└── utils/           # retry · path
```

The provider abstraction is provider-neutral: tools and the agent loop don't
know whether they're talking to Ollama or Anthropic. The same loop drives
the REPL and each per-chat conversation in the daemon.

## Configuration reference

`~/.asterisk/config.json`:

```jsonc
{
  "provider": "ollama",                       // or "anthropic"
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3.5:9b-q8-max",
    "contextWindow": 131072
  },
  "anthropic": { "model": "claude-3-5-haiku-latest" },
  "bots": {
    "telegram": {
      "enabled": false,
      "allowedUserIds": [],
      "streamMode": "final",                  // "final" | "status" | "stream"
      "streamThrottleMs": 1000,               // min gap between editMessageText calls
      "parseMode": "html"                     // "html" renders markdown · "plain" leaves it literal
    },
    "whatsapp": {
      "enabled": false,
      "transport": "meta-cloud",              // or "web-js"
      "metaCloud": {
        "phoneNumberId": "",
        "businessAccountId": "",
        "webhookPath": "/whatsapp/webhook",
        "webhookPort": 8787
      },
      "webJs": { "sessionDir": "" }
    }
  },
  "daemon": { "logLevel": "info", "heartbeatSeconds": 60 },
  "mcpServers": [],
  "hooks": []
}
```

`~/.asterisk/secrets.env` (chmod 600):

```bash
ANTHROPIC_API_KEY="..."
ASTERISK_TELEGRAM_BOT_TOKEN="..."
ASTERISK_WHATSAPP_META_TOKEN="..."
ASTERISK_WHATSAPP_VERIFY_TOKEN="..."
ASTERISK_NOTIFY_URL="..."     # optional — used by PushNotification tool
```

Override the config root with `ASTERISK_HOME=/path/to/dir`.

## Reliability

The agent loop wraps every model call in retry logic with exponential
backoff + jitter, honours the `Retry-After` header, classifies HTTP errors
into kinds (`rate-limit`, `overloaded`, `server`, `network`, `auth`,
`bad-request`, `context-overflow`, `aborted`), and threads `AbortSignal`
end-to-end so Ctrl+C cleanly cancels the in-flight provider call, the
sleep, and any running tool.

Every tool call is timeboxed (default 120s) by an inner `AbortController`
that ANDs the parent signal with the timeout — runaway shell commands
can't lock the loop.

## Limitations

- Conversation history, tasks, plan-mode, and worktree state live in
  memory; daemon restart wipes them. SOUL.md personas survive (they're
  files under `~/.asterisk/`), but task lists do not.
- No streaming responses yet — the loop awaits each turn fully.
- No model-side compaction when context is near full (tracked).
- No image content blocks back to the model, so it can't *see* the
  screenshots it captures (tracked).

## License

[Apache 2.0](./LICENSE).
