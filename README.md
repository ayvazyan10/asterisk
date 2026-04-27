# Asterisk

A lightweight, local-first AI agent CLI built on the public `@anthropic-ai/sdk`.
Status: **in development** (v0.1.0).

Asterisk runs as either an interactive terminal REPL or a long-running daemon
with optional Telegram and WhatsApp bot bridges. It defaults to a local Ollama
model and falls back to the Anthropic API when configured.

## Quick start

```bash
bun install
bun run build
./bin/asterisk          # REPL mode
./bin/asterisk start    # daemon mode
./bin/asterisk configure
```

Full docs land in `docs/` as features ship.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
