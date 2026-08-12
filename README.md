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

Status `0.3.0` — early but real. 44 built-in tools, 28 slash commands,
14 daemon-managed scheduling/lifecycle features, **29 bundled skills**,
**27 specialised sub-agent types** the agent can dispatch on demand,
layered multi-language rules, switchable output styles
(default / concise / explanatory / learning), a SOUL.md persona
system that bot users can manage per-chat, and an agent loop
hardened with tool concurrency, context compaction, prompt caching,
a Bash permission boundary, file history, and conversation persistence.

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

### From npm

```bash
npm install -g @ayvazyan10/asterisk
```

Published under a scope because the bare `asterisk` name on npm belongs to an
unrelated package. **Bun must already be installed** — the bundles target the
Bun runtime, and npm will not bring it along; the `asterisk` command stops with
an install hint if it can't find Bun. Browser tools also need a one-off
`bun playwright install chromium`. The one-line installer above handles both
for you, which is why it stays the recommended path.

macOS and Linux only, including WSL. The `asterisk` command is a bash
dispatcher, so Windows without WSL is not supported.

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
- A local model server — Ollama, or anything speaking the OpenAI
  `/v1/chat/completions` API (llama.cpp's `llama-server`, LM Studio, vLLM,
  Jan, LocalAI) — OR an `ANTHROPIC_API_KEY`.

### Connecting a local model

Ollama works out of the box. For everything else, point Asterisk at the
endpoint and pick the `openai-compatible` provider:

```bash
asterisk configure       # answer "openai-compatible", then the base URL + model
# or, in the REPL:
/provider openai-compatible
/model gemma-4-26b
```

A llama.cpp server started with `--alias gemma-4-26b --port 8080` is reached
at `http://127.0.0.1:8080/v1`. Tool calling, streaming, and reasoning output
(`--reasoning-format deepseek`) are all supported. Set
`ASTERISK_OPENAI_API_KEY` only if the endpoint is a hosted service that needs
one.

```bash
asterisk                # interactive REPL
asterisk start          # daemon mode (Telegram / WhatsApp bridges)
asterisk status         # daemon pid + log size
asterisk logs 100
asterisk restart
asterisk stop
asterisk configure      # interactive wizard for provider + bots + MCP
asterisk web            # web control panel for every setting
asterisk help
```

## Web control panel

`asterisk web` serves a settings UI at `http://127.0.0.1:4321`. It is the
whole configuration surface in one place:

- **Settings** — every field Asterisk understands, with its validation
  bounds and help text. The form is generated from the configuration
  schema, so it is never out of date with the code.
- **Secrets** — API keys and bot tokens. Values are write-only: the browser
  only ever receives a masked fingerprint.
- **MCP servers** and **hooks** — add, edit, enable, delete.
- **Rules & skills** — a markdown editor for your rules, skills, sub-agent
  definitions and persona files.
- **Diagnostics, daemon control, log tail, audit trail** — the same ground
  as `/doctor`, `asterisk start|stop`, and `asterisk logs`.

```bash
asterisk web                     # prints a link with a one-time token
asterisk web --port 8080
asterisk web --print-token       # issue another token
asterisk web --no-auth           # loopback binds only
```

A token is required by default and is exchanged for an httpOnly session
cookie on first load. Only SHA-256 hashes are stored, so a lost token is
regenerated rather than recovered. Binding to a non-loopback address without
authentication is refused outright.

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
| `/agents`          | List specialised sub-agent types you can dispatch           |
| `/output-style`    | Switch reply style — default / concise / explanatory / learning |
| `/rules`           | List the rules currently loaded into the system prompt      |
| `/skills`          | List installed skills; `validate` reports broken ones        |
| `/skill [name]`    | Run a skill — picker if no name given                       |
| `/soul [verb]`     | Show / `init` / `where` your SOUL.md persona                |
| `/plan`            | Toggle Plan Mode (read-only research mode)                  |
| `/tasks`           | List the agent's in-flight tasks for this session           |
| `/hooks`           | Manage agent-loop lifecycle hooks (visual)                  |
| `/permissions`     | Inspect and edit what `Bash` may run without asking         |
| `/doctor`          | Diagnostics — checks Ollama, Anthropic, system tools, MCP   |
| `/quit`            | Exit the REPL                                               |

## Built-in tools

The agent has these tools out of the box:

**Filesystem & shell**
`Bash` · `Read` · `Write` · `Edit` · `Grep` · `Glob`

The agent can **see** the screenshots it takes: `BrowserScreenshot` feeds the
image back through the model's vision input, capped and evicted from history
by the `vision` settings. Turn it off for a text-only model.

**Browser (real Chromium via Playwright)**
`BrowserNavigate` · `BrowserClick` · `BrowserType` · `BrowserPress` ·
`BrowserSnapshot` · `BrowserScreenshot` · `BrowserWait` · `BrowserClose`

**Web research**
`WebFetch` (URL → readable text) · `WebSearch` (Brave / Tavily / SearXNG /
DDG instant-answer, picks the first backend you've configured a key for)

**Memory**
`Remember` · `Recall` — notes that survive across sessions, searched with
SQLite FTS5 (falling back to substring search on a build without it).

**Planning**
`TaskCreate` · `TaskUpdate` · `TaskList` · `TaskGet` · `TaskStop` — the
agent's own todo list, used to track multi-step work.

**Plan Mode**
`EnterPlanMode` / `ExitPlanMode` — toggle a flag that hides write tools so
the agent can only research.

**Delegation**
`Agent` — spawn a sub-agent in an isolated conversation for focused
research or parallel investigation. Pass `subagent_type: <name>` to
dispatch a specialised role (code-reviewer, security-reviewer, planner,
explore, …) — see [Sub-agent types](#sub-agent-types) below.

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

**Tool discovery**
`ToolSearch` — keyword search across all registered tools. Enables
deferred tool loading so the full tool list doesn't bloat every prompt.

Plus any tools exposed by configured MCP servers, namespaced as
`<servername>__<toolname>`.

## Skills, rules, hooks, souls

**Skills** — reusable workflows. 29 bundled out of the box:

*Core workflow:*
- `simplify` — review your recent changes for reuse / quality / efficiency
- `batch` — apply one operation across many targets, with progress tracking
- `stuck` — diagnose why a task is blocked, propose alternatives
- `dream` — free-form roam, find one improvement worth making
- `skillify` — capture the current conversation as a new SKILL.md
- `verify` — run typecheck / lint / tests / build, classify each result,
  isolate root causes for any failures
- `debug` — diagnose a specific failure end-to-end: reproduce, read the
  error literally, hypothesise + verify, propose a concrete fix, re-run
- `feature` — drive a feature plan → implement → review → verify →
  commit, with Plan Mode discipline on the planning phase

*PRP pipeline (granular alternative to `feature`):*
- `prp-plan` — write a one-page Plan-Requirements-Pitch doc in Plan Mode
- `prp-implement` — execute against the PRP doc, with task tracking + verify
- `prp-pr` — open a real GitHub PR with summary + test plan via `gh`
- `prp-commit` — write a coherent commit with a real WHY message

*Loops + scheduling:*
- `loop` — recurring task with explicit stop conditions
- `schedule` — friendly wrapper over `ScheduleWakeup` / `CronCreate`
- `santa-loop` — adversarial dual-review: dispatches `code-reviewer`
  and `security-reviewer` sub-agents in parallel, iterates until both
  approve or hits a 5-round cap

*Quality / security tooling:*
- `dep-audit` — `npm audit` / `cargo audit` / `pip-audit` / `govulncheck`,
  classify by severity, propose upgrades
- `security-scan` — active scanning (gitleaks for secrets, trivy / gosec /
  bandit / semgrep / tfsec depending on stack)
- `cloud-infrastructure-security` — IaC review for Terraform / Pulumi /
  CDK / Helm / K8s / CloudFormation: IAM wildcards, exposed ports,
  plaintext secrets, supply-chain
- `pr-review` — review an open GitHub PR end-to-end via \`gh\`

*LLM / agent ops:*
- `ai-regression-testing` — golden-trace harness for LLM outputs
- `eval-harness` — score outputs against a rubric (graded eval)
- `prompt-optimizer` — iterate on a prompt with measurable lift
- `mcp-server-patterns` — build an MCP server with the public SDK
- `data-scraper-agent` — robust scraper using `BrowserNavigate` + `Snapshot`
- `regex-vs-llm-structured-text` — tactical guide on when to reach for
  each (and the hybrid pre-filter pattern)

*Auditing your setup:*
- `audit-memory` — inventory rules / souls / hooks; flag stale entries
- `skill-stocktake` — inventory user-installed skills + agents; surface
  dead weight

*Other:*
- `release-notes` — generate notes from `git log <prev>..HEAD`, grouped
  by type, with breaking changes promoted
- `youtube-summarizer` — summarise a YouTube video (uses `yt-dlp` if
  available for the transcript, falls back to WebFetch on description)

Add your own at `~/.asterisk/skills/<name>/SKILL.md` (user-global) or
`<repo>/.asterisk/skills/<name>/SKILL.md` (project-local). User/project
skills override bundled ones with the same name.

**Rules** — markdown auto-loaded into the system prompt. Two layouts:

*Flat (simple):*
- `~/.asterisk/rules/*.md` — user-global (e.g. tone, coding style)
- `<repo>/.asterisk/rules/*.md` — project-local
- `<repo>/ASTERISK.md` — project root marker

*Layered (multi-language):*
- `~/.asterisk/rules/common/*.md` — universal, always loaded
- `~/.asterisk/rules/<lang>/*.md` — only loaded when the project's
  primary language matches (`typescript`, `python`, `golang`, `rust`,
  `java`, `php`, `swift`, `dart`, `cpp`, `web`, `ruby`, …).
- Same structure under `<repo>/.asterisk/rules/`.
- Auto-detection from manifest files (`package.json`, `Cargo.toml`,
  `pyproject.toml`, `go.mod`, …). Override via `ASTERISK_LANG=python`.

**Output styles** — pluggable behaviour modifiers spliced into the
system prompt alongside rules + soul. Switch via `/output-style <name>`
in the REPL or `/style <name>` in the bots; persists to `config.json`.
Four bundled:

- `default` — baseline, no extra style instructions.
- `concise` — trim every reply to the minimum useful answer; lists
  over prose; skip preambles and pleasantries.
- `explanatory` — show reasoning + tradeoffs alongside the answer.
  Good for learning a codebase or onboarding to a domain.
- `learning` — collaborative; the agent surfaces non-trivial design
  decisions via `AskUserQuestion` and waits for the user to pick before
  applying.

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

## Sub-agent types

The `Agent` tool can dispatch a sub-agent with a tailored system prompt
and (sometimes) a restricted tool-set. The parent agent passes
`subagent_type: <name>` to pick a specialist; omitting it spawns a
general-purpose sub-agent with the parent's full tools.

**27 bundled types out of the box:**

- **Exploration / research:** `general-purpose`, `explore` (read-only
  scout), `docs-lookup`
- **Planning / architecture:** `planner`, `architect`
- **Code review:** `code-reviewer`, `security-reviewer`,
  `database-reviewer`, `performance-optimizer`, `refactor-cleaner`,
  `doc-updater`
- **Language-specific reviewers:** `typescript-reviewer`,
  `python-reviewer`, `go-reviewer`, `rust-reviewer`
- **Build / test:** `build-error-resolver`, `tdd-guide`, `e2e-runner`
- **Domain:** `chief-of-staff` (multi-channel triage),
  `healthcare-reviewer`
- **Open-source pipeline:** `opensource-forker` →
  `opensource-sanitizer` → `opensource-packager`
- **Loops / harnesses:** `loop-operator`, `gan-planner`,
  `gan-generator`, `gan-evaluator`

Add your own at `~/.asterisk/agents/<name>.md` (user-global) or
`<repo>/.asterisk/agents/<name>.md` (project-local). Same markdown +
frontmatter format as skills:

```markdown
---
name: my-reviewer
description: Reviews against our internal style guide.
allowedTools: Read, Grep, Glob, Bash
maxTurns: 12
---
You review code against the patterns in our internal style guide …
```

User/project files override bundled by name. Run `/agents` to see what's
loaded.

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
│                    # rules, hooks, sub-agents, per-tool timeout,
│                    # tool concurrency, context compaction
├── agent/           # compaction.ts · file-history.ts · output-store.ts
│                    # persistence.ts — conversation save/restore
├── providers/       # ollama (default) · anthropic · errors (ProviderError)
├── tools/           # bash · read · write · edit · grep · glob ·
│                    # browser/ (Playwright) · webfetch · websearch ·
│                    # tasks · subagent · planmode · worktree · notify ·
│                    # monitor · ask · schedule · tool-search ·
│                    # approval · bash-gate · bash-permissions ·
│                    # command-parse · bash-safety · concurrency
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

Configuration lives in `~/.asterisk/asterisk.db` (SQLite, mode 0600). Edit it
with `asterisk web`, `asterisk configure`, or the REPL slash commands — not by
hand.

An existing `config.json` from an older install is imported automatically on
first run and renamed to `config.json.migrated`. The same shape is still what
the panel's **Download JSON** button produces and **Upload JSON** accepts:

```jsonc
{
  "provider": "ollama",                       // or "openai-compatible" | "anthropic"
  "providerFallback": [],                     // e.g. ["anthropic"] — tried when the primary is unreachable
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3.5:9b-q8-max",
    "contextWindow": 131072
  },
  "openaiCompatible": {                       // llama.cpp / LM Studio / vLLM / …
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "gemma-4-26b",                   // blank = server default
    "maxTokens": 0,                           // 0 = let the server decide
    "modelTimeoutMs": 300000,
    "modelIdleTimeoutMs": 90000
  },
  "anthropic": { "model": "claude-haiku-4-5" },
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
  "vision": {                                 // images sent to the model
    "enabled": true,                          // off for a text-only model
    "maxPerTurn": 2,
    "maxBytes": 4000000,
    "keepInHistory": 2                        // older ones become a note
  },
  "sandbox": {                                // what a command may reach — see "Sandbox"
    "mode": "auto",                           // "auto" | "required" | "off"
    "network": true,                          // off blocks installs, git push, curl
    "writablePaths": []                       // beyond the workspace and /tmp
  },
  "permissions": {                            // what Bash may run — see "Permissions"
    "mode": "ask",                            // "ask" | "allowlist" | "unrestricted"
    "allow": [],                              // extra rules, e.g. ["npm test", "docker ps"]
    "deny": [],                               // refused outright, beats every allow
    "headless": "deny",                       // daemon / bots, where nobody can answer
    "timeoutSeconds": 90
  },
  "web": {
    "host": "127.0.0.1",
    "port": 4321,
    "authRequired": true,
    "openBrowser": true
  },
  "mcpServers": [],
  "hooks": []
}
```

### Secrets

Secrets are stored in the database and set through `asterisk web` or
`asterisk configure`. They are resolved highest-priority-first:

1. the process environment,
2. the database,
3. a legacy `~/.asterisk/secrets.env`, read as a fallback and imported once.

```bash
ANTHROPIC_API_KEY="..."
ASTERISK_TELEGRAM_BOT_TOKEN="..."
ASTERISK_WHATSAPP_META_TOKEN="..."
ASTERISK_WHATSAPP_VERIFY_TOKEN="..."
ASTERISK_NOTIFY_URL="..."     # optional — used by PushNotification tool
```

Exporting one of these in your shell overrides whatever is stored, which is
useful for one-off runs and CI. Note this is the reverse of the pre-database
behaviour, where `secrets.env` won.

Override the config root with `ASTERISK_HOME=/path/to/dir`.

## Permissions

**This is a consent boundary, not a sandbox.** An approved command runs as
a normal child process with the full privileges of the user who started
Asterisk. What the boundary buys is that nothing with unreviewed effects
runs without someone saying yes — it is not containment, and a command you
approve can do anything you could do.

Read-only commands run immediately. Anything else prompts:

```
🔒  Approve this command?

    npm test -- --coverage

    Needs approval because "npm test -- --coverage" is not on the allowlist.

  › Allow once      Run it this time only.
    Allow always    Remember npm test and stop asking.
    Deny            Refuse, and tell the agent not to retry.
```

Commands are split into the segments the shell would actually run before any
rule is consulted, so `git status && rm -rf ~` needs approval even though
`git status` alone does not. Anything the parser cannot statically resolve —
command substitution, backticks, variable expansion, here-docs, subshells,
redirection to a real path — is never auto-approved, whatever the rules say.
Rules are matched positionally and are path-sensitive: a rule for `git` does
not hand approval to `./git`.

| `permissions.mode` | Behaviour                                              |
| ------------------ | ------------------------------------------------------ |
| `ask` (default)    | Allowlisted commands run; everything else prompts       |
| `allowlist`        | Anything not allowlisted is refused, never prompted     |
| `unrestricted`     | No boundary — the pre-0.4 behaviour, opt in explicitly  |

**Unattended runs.** The daemon and the bot bridges have nobody to prompt, so
`permissions.headless` decides for them. It defaults to `deny`: a command that
would have prompted is refused, with a message telling the user which rule to
add. Set it to `allow` only if you accept that unattended sessions then have
no boundary at all.

Manage it with `/permissions` in the REPL, or the **Permissions** section of
`asterisk web`:

```bash
/permissions                    # effective policy, config rules, remembered grants
/permissions builtin            # the built-in read-only set
/permissions allow "npm test"   # add a rule
/permissions deny  "git push"   # refuse outright, ahead of every allow
/permissions revoke             # pick a remembered grant to forget
```

The 14-regex denylist in `bash-safety.ts` still runs first, but it is defence
in depth rather than the boundary: `rm -r -f /`, `$(echo rm) -rf /` and
`sh -c '…'` all walk straight through it. The permission gate is what stops
them.

## Sandbox

Permissions decide *whether* a command runs. The sandbox decides what it can
reach once it does — and the two are independent, so an allowlisted read-only
command is confined too.

`Bash` runs under **bubblewrap** on Linux and **`sandbox-exec`** (seatbelt) on
macOS. The whole filesystem is bound read-only; the workspace and `/tmp` are
writable; `/dev` and `/proc` are fresh, so a command cannot see every other
process on the machine. Notably `~/.asterisk` is *not* writable: a command
cannot rewrite the secret store or the permission grants that let it run.

**A backend is not trusted until it proves itself.** On first use Asterisk
runs a probe that tries to write somewhere it must not be able to, and refuses
to use the backend unless that write fails. A sandbox that silently does not
sandbox is worse than none — it moves you from cautious to confident without
moving the security — so "installed" is never taken as "working".

| `sandbox.mode` | Behaviour                                                    |
| -------------- | ------------------------------------------------------------ |
| `auto` (default) | Confine when a probed backend exists, run unconfined otherwise |
| `required`     | Refuse to run commands at all when no backend is available     |
| `off`          | Never confine                                                  |

`sandbox.network` (default on) controls network access — turning it off blocks
package installs and `git push` along with everything else.
`sandbox.writablePaths` adds paths beyond the workspace and `/tmp`.

`/doctor` reports which backend is active and why. If it says `none`, you are
not sandboxed:

```
Security
  ✓ Bash perms mode ask · unattended runs deny
  ✓ Sandbox    bubblewrap — bwrap passed a containment probe
```

On Linux, `apt install bubblewrap` (or your distro's equivalent) is all it
takes. Its seatbelt counterpart ships with macOS.

## Reliability

**Provider fallback.** `providerFallback` lists backends to try, in order, when
the primary one cannot answer — a laptop whose Ollama is not running falls
through to a configured Anthropic key instead of failing every turn. Only
availability failures step down the chain (network, 5xx, overloaded, rate
limit, auth); a rejected request is *not* replayed elsewhere, because it would
fail there too and the switch would hide the real error. A reply that has
already begun streaming is never restarted on another backend. The chain
reports the smallest context window of its links, since the history is built
once and may be answered by any of them.

The agent loop wraps every model call in retry logic with exponential
backoff + jitter, honours the `Retry-After` header, classifies HTTP errors
into kinds (`rate-limit`, `overloaded`, `server`, `network`, `auth`,
`bad-request`, `context-overflow`, `aborted`), and threads `AbortSignal`
end-to-end so Ctrl+C cleanly cancels the in-flight provider call, the
sleep, and any running tool.

Every tool call is timeboxed (default 120s) by an inner `AbortController`
that ANDs the parent signal with the timeout — runaway shell commands
can't lock the loop. Press **ESC** in the REPL to abort the current turn
and clear the message queue.

**Agent loop hardening:**

- **Tool concurrency** — concurrency-safe tools (Read, Grep, Glob,
  WebFetch, WebSearch, …) run in parallel via `Promise.all` when the
  model emits multiple in one turn.
- **Context compaction** — the budget is 60% of the context window the
  active provider reports. Over it, old tool results and long text blocks
  are truncated while keeping the 6 most recent messages intact. If that is
  not enough, the oldest messages are dropped — and **replaced by a summary
  the model writes of what they contained**, so a long session keeps the
  decisions that shaped it instead of just a count of what was lost. A
  summariser that fails costs context and nothing else; the turn continues
  with the plain notice. Token counting is a character-class estimate, not
  `chars / 4`: CJK counts near one token per character and punctuation-dense
  code above the prose rate, because under-counting those is what silently
  overflows a window.
- **Large result persistence** — tool outputs > 8 KB are saved to
  `~/.asterisk/outputs/` with a 500-char preview kept in context.
- **Prompt caching** — Anthropic provider sends the system prompt with
  `cache_control: { type: 'ephemeral' }` for cross-turn caching.
- **Bash permissions** — read-only commands run; anything else needs the
  user's approval. See [Permissions](#permissions), including what it
  deliberately does not promise.
- **File history** — Write/Edit tools snapshot files before overwriting;
  stored in `~/.asterisk/file-history/`.
- **Conversation persistence** — daemon saves per-chat history to
  `~/.asterisk/conversations/` as JSON, restores on reconnect, 7-day
  expiry.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the prioritised list of upcoming work
— skill marketplace, image content blocks, multi-agent
coordinator, and others.

## Limitations

- Tasks, plan-mode, and worktree state live in memory; daemon restart
  wipes them. Conversation history now persists across daemon restarts
  (7-day expiry), but task lists do not.
- **The sandbox covers `Bash` only.** `Read`, `Write` and `Edit` run
  in-process, so no child-process sandbox can reach them; they are bounded by
  the workspace guard instead, which `ASTERISK_NO_WORKSPACE_GUARD=1` disables.
  The two boundaries nearly coincide — workspace-only writes either way — but
  they are enforced by different code and configured separately.
- **Reads are not confined.** The sandbox restricts what a command can
  *change*, not what it can see. A command you approve can read any file your
  user can.

## Provenance

Asterisk is an independent, clean-room implementation, written from published
API documentation and public npm packages. [PROVENANCE.md](./PROVENANCE.md)
sets out what that means concretely, which sources were used, what was
consulted as an architectural reference and what was not, and how to report
anything you believe was copied when it should not have been.

## License

[Apache 2.0](./LICENSE).
