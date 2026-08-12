# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bash permission boundary.** Read-only commands run as before; anything
  else asks the user to approve it, once or permanently. Commands are split
  into the segments bash would actually run before any rule is consulted, so
  `git status && rm -rf ~` is judged on both halves, and constructs that
  defeat static analysis — command substitution, backticks, variable
  expansion, here-docs, subshells, redirection to a real path — are never
  auto-approved. Rules match positionally and are path-sensitive, so a rule
  for `git` does not hand approval to `./git`.
- `permissions` config block: `mode` (`ask` | `allowlist` | `unrestricted`),
  `allow`, `deny`, `headless`, `timeoutSeconds`. Appears in the web control
  panel automatically.
- `/permissions` — show the effective policy, list the built-in read-only
  set, add allow/deny rules, and revoke remembered grants.
- Migration 4 adds `command_permissions`, holding the rules answered
  "allow always" together with who granted them.

### Changed

- **BREAKING — unattended runs refuse unapproved commands by default.** The
  daemon and the bot bridges have nobody to prompt, so `permissions.headless`
  answers for them and defaults to `deny`. A daemon that previously ran any
  command the model produced will now refuse anything outside the read-only
  allowlist, with a message naming the rule to add. Restore the old behaviour
  with `permissions.headless: "allow"`, or narrow it by listing the commands
  you actually want in `permissions.allow`.
- `bash-safety.ts` is now documented as defence in depth rather than a
  security boundary, in the code, the README and `CLAUDE.md`. It always was
  one — `rm -r -f /`, `$(echo rm) -rf /` and `sh -c '…'` walk straight
  through its 14 regexes.

### Fixed

- `ROADMAP.md` still advertised the token and cost tracking removed in
  `bdbd2b7`, and described context compaction by the hard-coded 80k threshold
  replaced in `53ce875`.

## [0.1.0] - 2026-04-27

Initial public release.

### Added

- Interactive Ink REPL with Static transcript and live tool-use streaming.
- Provider abstraction with two implementations:
  - `ollama` (default) — direct HTTP client for Ollama's `/api/chat` endpoint.
  - `anthropic` — wrapper over the public `@anthropic-ai/sdk`.
- Six tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`.
- Five slash commands: `/help`, `/clear`, `/model`, `/config`, `/quit`.
- Daemon lifecycle: `start`, `stop`, `restart`, `status`, `logs` with PID
  file management and a `pino`-backed log file.
- Configuration system at `~/.asterisk/`:
  - `config.json` (Zod-validated schema)
  - `secrets.env` (chmod 600)
  - Interactive `asterisk configure` wizard.
- Bot adapters wired into the daemon:
  - Telegram via [grammy](https://grammy.dev) with `allowedUserIds` enforcement.
  - WhatsApp Meta Cloud API webhook receiver.
  - WhatsApp web-js (unofficial; ToS-warned, personal use only).
- 25 tests (Vitest) covering tools, agent loop, daemon lifecycle, config
  persistence, and bot manager wiring.
