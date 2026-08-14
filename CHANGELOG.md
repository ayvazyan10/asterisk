# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **`asterisk web` starts in the background.** It prints the panel's URL — with
  the first-run token when one is minted — and hands the terminal back; the
  server itself runs as a detached child. Previously it held the terminal until
  Ctrl+C, so leaving the panel up meant `nohup … &`, and freeing the port meant
  finding the pid by hand. `asterisk web stop` now terminates it and releases
  the port. `--foreground` keeps the old blocking behaviour, which is the shape
  systemd and containers want.
- The panel gets its own process state, separate from the daemon's:
  `~/.asterisk/web.pid`, `~/.asterisk/logs/web.log` and `~/.asterisk/web.json`
  (pid, host, port and URL of the running instance — never a token, since only
  token hashes are stored). Separate on purpose: `asterisk stop` must not take
  the panel down, and `asterisk web stop` must not stop the bots.

### Removed

- **Plugins.** The in-process TypeScript extension surface is gone: `src/plugins`,
  the `/plugins` command, the `plugins.*` settings and the control-panel page
  added for them. A plugin ran with the secret store, the tool registry and the
  permission gate, and nothing could confine it — bubblewrap confines child
  *processes*, and a plugin is a function call. Everything one could do, an MCP
  server does from outside the process, and Asterisk already speaks MCP as a
  client. Shell hooks are unaffected: they hook the same lifecycle events and
  they are child processes.
- Migration 8 clears any `plugins.*` rows an older install left in `settings`.
  Plugin *files* are left alone — Asterisk never wrote them.

## [0.4.1] - 2026-08-13

### Fixed

- **`asterisk update` on an npm install.** It assumed the `install.sh` layout —
  a git clone at `~/.local/share/asterisk` — so anyone who ran
  `npm i -g @ayvazyan101/asterisk` was told "…is not a git repository. Run
  install.sh first," which would have installed a second copy over the one
  already working. It now recognises the npm layout from its own path and
  prints `npm i -g @ayvazyan101/asterisk@latest` instead.
- **`asterisk update` ran on import.** `main()` was called at module scope, so
  importing the module performed a real `git fetch` and would have performed a
  real `git reset --hard` on the install directory. Found the moment a test
  imported it for a pure helper — against a live install. Now guarded on being
  the executed entry. `acp.ts`, `control.ts`, `web.ts` and `mcp-server.ts`
  still share the pattern; they start servers rather than mutating an install,
  so they are noted rather than changed.

### Changed

- **The published bundles are minified**, taking the package from 8.1 MB
  packed / 44.3 MB unpacked to 5.9 MB / 20.2 MB. Stated plainly rather than
  sold as free: a stack trace from a minified bundle loses its function names.
  What it does not lose is more than it looks — the bundle was already a single
  concatenated file with no mapping back to source — and `src/` ships in the
  package either way. Bun's `keepNames` was measured and makes no difference,
  and keeping identifiers costs two thirds of the saving.

### Added

- The Telegram adapter is covered, 32% to 95% of statements. `Bot` is faked so
  the registered handler can be driven directly; `GrammyError` is deliberately
  the real class, since most of what matters is how the adapter reacts to
  Telegram rejecting something. The pass also merged an attachment loop that
  existed twice — a test of one copy proved nothing about the other.

## [0.4.0] - 2026-08-12

### Added

- **`RunCode`** — run a short program that calls Asterisk's own tools in a
  loop, in one turn instead of N. Bash can already loop; what it cannot do is
  call `Edit`, `Grep`, `WebFetch` or `Remember`. The language is a subset of
  JavaScript evaluated by an interpreter, **not** `node:vm`: a vm context
  handed one host callable is not a boundary, since `callTool.constructor(…)`
  reaches the host realm's `Function` and from there `process.env` and
  `fs.writeFileSync`. Tools are resolved through the same registry the agent
  loop uses, so `Bash` from a program still asks for approval and `Write`
  still refuses paths outside the writable set — it is the same call.
  Bounded on wall clock, tool calls, interpreter steps, call depth and value
  size. `RunCode`, `Agent` and `AskUserQuestion` are not reachable from a
  program.
- **Interface language** — English and Russian, chosen by `ASTERISK_LANG` or
  the system locale. Only what the *user* reads is translated; the system
  prompt, tool names, tool descriptions and tool results stay English in every
  locale, because those are behaviour rather than presentation.
- **`asterisk mcp-server`** — serve Asterisk's memory, skills and rules to
  other agents over MCP. Bash, Write and Edit are deliberately not exposed.
- **Plugins** — in-process TypeScript modules that can register tools and
  lifecycle handlers. Off by default; the sandbox does not confine them.
- **`/plugins`** — what is loaded, what failed, and what would load.
- Releases publish to npm as `@ayvazyan101/asterisk` with provenance. The step
  is skipped rather than failed when no token is configured, so a fork still
  cuts a release.

### Changed

- **`sandbox.writablePaths` now governs `Write` and `Edit` too.** The file
  tools had a separate workspace guard, so widening the boundary for the shell
  silently left them where they were. One module answers for both now. `/tmp`
  stays shell-only on purpose: reaching it through Bash costs an approval
  prompt, through Write it costs nothing.
- REPL coverage from 7% to 77%, repo-wide lines 50% to 65%. Fixed a stray
  character typed into the prompt by Ctrl+O, and removed dead duplicate modal
  handlers the tests exposed.
- The build script pins its output root. The ninth entrypoint made Bun mirror
  the source tree into `dist/` instead of flattening it, which silently missed
  every path in the dispatcher.
- CI installs ripgrep, and `/code` names it as the cause when it is missing
  rather than reporting an empty result.

### Removed

- **WhatsApp support (breaking).** Both transports are gone: the Meta Cloud
  path needed a Business Manager account most users of a personal assistant
  will never have, and the web-js path drove WhatsApp Web through Puppeteer in
  violation of WhatsApp's Terms of Service. Shipping a ToS violation as a
  documented feature was the wrong default, however prominent the warning.
  A migration deletes the orphaned `bots.whatsapp.*` settings and the
  `ASTERISK_WHATSAPP_*` secrets — the latter matters, because a secret whose
  key has left `SECRET_KEYS` is unreadable, unlistable and undeletable by any
  code path while remaining a live credential in the database. **The migration
  revokes nothing upstream.** A Meta token stays valid until you revoke it in
  Meta's console, and a linked web-js device stays linked until you remove it
  in WhatsApp → Linked Devices. `~/.asterisk/whatsapp-web-session/` is left on
  disk on purpose: deleting it destroys the evidence while leaving the grant
  alive. Unlink first, then delete it.

### Fixed

- Five slash-command bugs that a coverage pass surfaced: `/config provider`
  omitted `openai-compatible`, so picking it silently moved the user to Ollama;
  `/model` offered Anthropic models on non-Anthropic providers, writing Claude
  ids into `openaiCompatible.model`; `/mcp edit` skipped the validation
  `/mcp add` performs; `/code`'s "no matches" branch was unreachable; and
  `/doctor`'s config line could not be reached after `loadConfig()` migrated
  the file.

## [0.3.0] - 2026-08-12

Everything that turned the permission boundary into a real one, gave the agent
eyes and a memory, and made it survive the small local models it was always
meant to run on.

### Added

- **The agent can see its screenshots.** `BrowserScreenshot` feeds the image
  back to the model as a content block rather than only reporting a path.
  Mapped per provider (Anthropic `source`, Ollama `images`, OpenAI-compatible
  `image_url`) — each silently ignores an unrecognised block, so the mapping is
  the feature. New `vision` settings cap size, count per turn, and how many
  images survive in history.
- **Bash runs in an OS sandbox** — bubblewrap on Linux, seatbelt on macOS, with
  a containment probe that refuses to trust a backend that has not demonstrated
  it works. See the README's Sandbox section for what it does and does not
  cover.
- **Dropped history is summarised** rather than replaced by a bare count.
- **`/permissions`** and the Bash permission boundary.
- **Persistent memory** — `Remember` / `Recall` backed by SQLite FTS5, with a
  substring fallback where the build lacks it. No delete path yet, and memory
  is install-wide.
- **`AgentBatch`** — dispatch several sub-agents for one turn. Read-only agent
  types run concurrently; anything that can write runs sequentially, because
  sub-agents share one filesystem view.
- **A SKILL.md contract** — frontmatter validation with actionable errors, plus
  `/skills validate`. Previously a malformed skill was silently skipped.
- **`asterisk eval`** — scenario harness graded by objective criteria, offline
  in CI and `--live` against a real model.
- **`asterisk acp`** — Agent Client Protocol server on stdio, so an editor can
  drive the agent. Documented core only; unproven against a real ACP client.
- **`Forget`** — delete a note by id from long-term memory.
- **Local-model robustness** — tool calls emitted as text, invented namespaced
  tool names, unparseable arguments, empty completions and runaway repetition
  are all recovered or reported instead of ending the turn.
- **Provider fallback chain** (`providerFallback`) — try another backend when
  the primary is unreachable, without replaying a rejected request or
  restarting a reply that has already begun streaming.

### Changed

- Token counting is a character-class estimate instead of `chars / 4`, which
  under-counted Chinese by 3.7x and let CJK conversations overflow the window
  with compaction never firing.
- Interactive tools are no longer killed by the 120s runaway-work deadline, so
  a prompt can actually wait for a person.
- `registry.ts` split into per-domain command modules; lint covers `scripts/`
  and holds at zero warnings.

## [0.2.0] - 2026-08-12

Everything between the initial release and today, gathered into one entry.
0.1.0 was the only version ever tagged; the ~90 commits since were never
described here.

Headline: configuration moved into SQLite behind a web control panel, the
tool set grew from 6 to 40, providers gained a universal local-model path,
and the `Bash` tool acquired a permission boundary. Two features shipped and
were then removed on purpose — see **Removed**.

### Added

- **Bash permission boundary.** Read-only commands run straight through;
  anything else asks the user to approve it, once or permanently. Commands
  are split into the segments bash would actually run before any rule is
  consulted, so `git status && rm -rf ~` is judged on both halves, and
  constructs that defeat static analysis — command substitution, backticks,
  variable expansion, here-docs, subshells, redirection to a real path — are
  never auto-approved. Rules match positionally and are path-sensitive, so a
  rule for `git` does not hand approval to `./git`. Configured under
  `permissions`; inspected and edited with `/permissions`.
- **SQLite-backed configuration and a web control panel.** `~/.asterisk/asterisk.db`
  (mode 0600, WAL) is the source of truth. `asterisk web` serves settings,
  masked secrets, MCP servers, hooks, a markdown editor for rules, skills,
  agents and souls, daemon start/stop, diagnostics, log tail, an audit trail
  and token management. The settings form is generated from the Zod schema,
  so a new config field appears in the browser with the right widget and
  bounds without any UI code.
- **Universal local-model provider.** `openai-compatible` speaks to
  llama.cpp's llama-server, LM Studio, vLLM, Jan, LocalAI, or any
  `/v1/chat/completions` proxy. Ollama keeps a dedicated provider because
  Asterisk drives its native API. All providers are now built through one
  factory, which also reports *why* it fell back.
- **34 more tools, for 40 total.** A full Playwright browser suite
  (`BrowserNavigate`, `BrowserClick`, `BrowserType`, `BrowserPress`,
  `BrowserSnapshot`, `BrowserScreenshot`, `BrowserWait`, `BrowserClose`),
  `WebFetch` and `WebSearch` (Brave / Tavily / SearXNG / DDG), a task
  tracker, sub-agent dispatch, plan mode, worktrees, `Monitor`, `Notify`,
  `AskUserQuestion`, `Schedule` with cron, `Attach` for sending files through
  the bots, code intelligence, diff review, and `ToolSearch` for deferred
  tool discovery.
- **Rules, skills, hooks, agents, output styles, personas.** 29 bundled
  skills, 27 specialised sub-agent types, 4 output styles, layered
  per-language rules with auto-detection, lifecycle hooks that can block or
  rewrite a tool call, and `SOUL.md` personas including per-session ones so
  each bot user can define their own.
- **23 more slash commands, for 28 total**, all visual — `/` opens a filtered
  menu and picking opens a form or list picker.
- **Agent loop hardening.** Retry with exponential backoff and jitter,
  `Retry-After`, error classification into kinds, end-to-end `AbortSignal`,
  per-tool timeouts, parallel execution of concurrency-safe tools, context
  compaction, large tool results spilled to `~/.asterisk/outputs/`, Anthropic
  prompt caching, file-history snapshots before overwrites, and conversation
  persistence across daemon restarts with a 7-day expiry.
- **Per-session isolation** across Telegram, WhatsApp and REPL users, so
  concurrent chats cannot see each other's history or state.
- **Telegram reply modes** — `final`, `status`, `stream` — with real provider
  streaming, throttled edits, and markdown rendered through HTML parse mode.
- **Self-update** — `asterisk update` and `/update`.
- **One-line installer** and a global `asterisk` command.
- **`/doctor`** — checks Ollama and Anthropic connectivity, system tools, MCP
  servers, config files and daemon status.
- **Workspace guard** — `Edit` and `Write` refuse paths outside the workspace
  root unless `ASTERISK_NO_WORKSPACE_GUARD=1` is set.

### Changed

- **BREAKING — unattended runs refuse unapproved commands.** The daemon and
  the bot bridges have nobody to prompt, so `permissions.headless` answers for
  them and defaults to `deny`. A daemon that previously ran whatever the model
  produced now refuses anything outside the read-only allowlist, with a
  message naming the rule to add. Restore the old behaviour with
  `permissions.headless: "allow"`, or list what you want in
  `permissions.allow`.
- **BREAKING — `config.json` is no longer the source of truth.** An existing
  file is imported on first run and renamed `config.json.migrated`. It
  survives only as the import/export format.
- Agent turn safety cap raised from 12 to 48.
- Ollama structured thinking is off by default, and reasoning output is routed
  to a separate channel rather than mixed into assistant text.
- `bash-safety.ts` is documented as defence in depth rather than a security
  boundary — it always was one. `rm -r -f /`, `$(echo rm) -rf /` and
  `sh -c '…'` walk straight through its 14 regexes.
- Lint and coverage are real CI gates. Lint previously ran behind
  `continue-on-error` with 750 diagnostics; the coverage thresholds had never
  executed once, because `@vitest/coverage-v8` was not installed and
  `--coverage` simply errored.
- Biome replaced ad-hoc formatting.
- Tests grew from 25 to 668.

### Removed

- **Token and cost tracking.** Shipped as `/cost`, `/usage`, a Telegram
  command and a web panel tab, then removed along with its tables. The numbers
  were estimates dressed as accounting: local models are free, hosted rates
  drift, and nothing in the product acted on the figure.
- **Skill marketplace.** Designed, then dropped on 2026-07-31. The bundled set
  is the whole story; skills are authored by hand or through the panel's
  editor. The design notes are kept in `ROADMAP.md`.

### Fixed

- ESC during a multi-tool turn stranded `tool_use` blocks with no matching
  `tool_result`, so every later request failed with a non-retryable 400 — and
  `/resume` faithfully restored the corruption. History now carries a pairing
  invariant and repairs transcripts written by older builds on load.
- Context compaction could never fire on a default install: the threshold was
  hard-coded at 80,000 tokens while Ollama's default window is 65,536. The
  budget is now 60% of whatever window the active provider reports.
- A migration race let the REPL, daemon and `asterisk web` — which routinely
  start together on a fresh install — all observe an empty migration set and
  race to create the same tables.
- A TOCTOU window in pidfile handling.
- Daemon turns are serialised per chat, resident chats are LRU-bounded, and
  failures surface instead of hanging.
- Empty turns no longer end silently; the loop falls back to a synthesised
  summary of what ran.
- File-history backups collided when two writes landed in the same
  millisecond.

### Security

- **Secrets were world-readable.** The database was created 0600 *after* WAL
  was enabled, so the `-wal` and `-shm` sidecars inherited the umask instead —
  and the WAL held a verbatim copy of every secret written. The database is
  now created 0600 before WAL is switched on, and `fs-safe.ts` applies
  0600/0700 across the whole state directory: outputs, transcripts,
  file-history, screenshots.
- **The web control panel was vulnerable to DNS rebinding**, which meant
  remote code execution from a visited web page. Host, `Sec-Fetch-Site`,
  `Origin` and opaque-origin checks now run *before* authentication.
  `--no-auth` requires an explicit opt-in.
- MCP servers received the entire `process.env`; they now get an allowlist.
- `WebFetch` gained an SSRF guard.
- `allowedTools` on read-only sub-agent types was advisory; it is now enforced
  at execution time.
- Hooks fail closed — a hook that errors blocks the tool rather than allowing
  it through.
- `writeSecrets` no longer erases keys it was not asked to write.
- File-history snapshots inherited the mode of the file they copied; they are
  owner-only now.

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

[0.4.1]: https://github.com/ayvazyan10/asterisk/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ayvazyan10/asterisk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ayvazyan10/asterisk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ayvazyan10/asterisk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ayvazyan10/asterisk/releases/tag/v0.1.0
