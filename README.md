# Asterisk

A lightweight, personal AI assistant. Asterisk gives you an interactive
agent in your terminal and an optional long-running daemon that bridges the
same assistant to Telegram and WhatsApp.

- **Local by default** — talks to a local [Ollama](https://ollama.com) model
  out of the box; the public `@anthropic-ai/sdk` is wired in as an opt-in
  alternative.
- **Built on documented APIs** — Anthropic Messages API tool-use loop,
  Ollama HTTP API, Telegram Bot API (via [grammY](https://grammy.dev)),
  WhatsApp Meta Cloud API.
- **No telemetry, no cloud control plane.** Everything runs on your machine.
- **Apache 2.0** licensed.

Status: `0.1.0` — early but usable. Six file/shell tools, five slash commands,
daemon lifecycle, three bot transports.

## Install

One-line install (macOS / Linux / WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/install.sh | bash
```

The installer:

1. Installs [Bun](https://bun.sh) if it isn't already on your machine.
2. Clones Asterisk into `~/.local/share/asterisk`.
3. Builds `dist/`.
4. Symlinks `~/.local/bin/asterisk` so the `asterisk` command is on your PATH.

Override locations or branch via env vars on the receiving `bash`:

```bash
curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/install.sh \
  | ASTERISK_INSTALL_DIR=/opt/asterisk ASTERISK_BIN_DIR=/usr/local/bin bash
```

Available: `ASTERISK_INSTALL_DIR` (default `~/.local/share/asterisk`),
`ASTERISK_BIN_DIR` (default `~/.local/bin`), `ASTERISK_BRANCH` (default
`master`), `ASTERISK_REPO_URL`.

To uninstall:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/uninstall.sh)
```

Your `~/.asterisk/` config is preserved unless you delete it explicitly.

### From source

```bash
git clone https://github.com/ayvazyan10/asterisk.git && cd asterisk
bun install
bun run build
./bin/asterisk help
```

## Quick start

Requirements:

- [Bun](https://bun.sh) ≥ 1.1 (handled by the installer)
- An Ollama server reachable from this machine, or an `ANTHROPIC_API_KEY`

After the installer finishes, the `asterisk` command is on your PATH:

### REPL

```bash
asterisk
```

You'll get an Ink-rendered prompt; type messages and the agent will use
`Bash`, `Read`, `Write`, `Edit`, `Grep`, and `Glob` tools to inspect and modify
your project. Slash commands: `/help`, `/clear`, `/model`, `/config`, `/quit`.

### Daemon

```bash
asterisk start      # spawn the daemon, write ~/.asterisk/asterisk.pid
asterisk status     # show pid + log size
asterisk logs 100   # tail the last 100 daemon log lines
asterisk restart
asterisk stop
```

The daemon hosts whichever bot adapters you enabled in your config.

### Configure

```bash
asterisk configure
```

Walks an interactive wizard that writes:

- `~/.asterisk/config.json` — provider choice, Ollama URL/model, bot toggles,
  WhatsApp transport choice.
- `~/.asterisk/secrets.env` (chmod 600) — API keys and bot tokens.

## Bot transports

| Transport            | Status                | Notes                                              |
| -------------------- | --------------------- | -------------------------------------------------- |
| Telegram (grammY)    | Recommended           | Bot token from @BotFather; allowlist required.     |
| WhatsApp Meta Cloud  | Recommended           | ToS-compliant; needs Meta Business Manager setup.  |
| WhatsApp web-js      | **Personal use only** | Drives WhatsApp Web via Puppeteer. Violates WhatsApp ToS. Risks number bans. |

All bot writes are gated by config — no transport runs unless you explicitly
enable it via `asterisk configure`.

## Architecture

```
bin/asterisk          # Bash dispatcher: REPL | start | stop | status | logs | configure
src/
├── entrypoints/      # cli.tsx · daemon.ts · control.ts · configure.tsx
├── repl/             # Ink REPL component
├── agent/            # tool-use loop
├── providers/        # ollama (default) · anthropic
├── tools/            # Bash · Read · Write · Edit · Grep · Glob
├── commands/         # /help · /clear · /model · /config · /quit
├── bots/             # adapter contract · telegram · whatsapp/{meta-cloud, web-js}
├── config/           # zod schema · loader · interactive wizard
├── daemon/           # pidfile · logger · lifecycle
└── types/            # shared message types
```

The provider abstraction is provider-neutral: tools and the agent loop don't
know whether they're talking to Ollama or Anthropic.

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
    "telegram": { "enabled": false, "allowedUserIds": [] },
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
  "daemon": { "logLevel": "info", "heartbeatSeconds": 60 }
}
```

`~/.asterisk/secrets.env` (chmod 600):

```bash
ANTHROPIC_API_KEY="..."
ASTERISK_TELEGRAM_BOT_TOKEN="..."
ASTERISK_WHATSAPP_META_TOKEN="..."
ASTERISK_WHATSAPP_VERIFY_TOKEN="..."
```

Override the config root with `ASTERISK_HOME=/path/to/dir`.

## Limitations

- Conversation history is in-memory per chat; daemon restart wipes it.
- Tool catalogue is small by design — add your own in `src/tools/`.
- No multi-agent routing, no plugin hooks, no MCP server mode (yet).

## License

[Apache 2.0](./LICENSE).
