# Asterisk roadmap

Forward-looking work, ranked by priority within each tier. Items move from
here into commits as they ship.

## Tier 1 — Likely next

### Skill marketplace
**Status:** designed, not started · **Effort:** medium

Add `/skill install <name-or-url>` so users can pull `SKILL.md` files
from a public registry instead of relying solely on bundled defaults.
Same shape as MCP servers but for skills.

- Registry index lives at a known URL (GitHub repo with a top-level
  `index.json` listing entries: name · description · download URL ·
  author · checksum).
- `/skill install <name>` resolves the name against the index, fetches
  the `SKILL.md`, drops it into `~/.asterisk/skills/<name>/SKILL.md`,
  and verifies the checksum.
- `/skill install <url>` lets users install from any HTTPS URL.
- `/skill uninstall <name>` removes a user-scoped skill.
- New mirror knob in `config.json`: `skillRegistry.indexUrl` so private
  registries are supported.
- Same pattern would apply to **agents** (`/agent install`) and
  potentially rules — but skills first.

**Why this earns its slot:** lets us ship a focused bundled set (the
current 29) and let users pull on-demand framework-specific skills
(`django-patterns`, `springboot-tdd`, `kotlin-coroutines-flows`, …) from
a public repo rather than baking 60+ niche skills into every install.
Keeps the catalogue navigable without losing reach.

**Open design questions:**

- Single official registry vs. multiple? (Probably allow multiple — let
  community registries flourish.)
- Sandbox the SKILL.md contents on install? (Probably not — they're
  prompts, not code; the real risk is prompt-injection on bad sources.)
- Update flow: `/skill update <name>` re-fetches and shows a diff before
  overwriting?

### Token / cost tracking
**Status:** infrastructure-light, content-heavy · **Effort:** medium

Wire token counts through the providers so users can see what their
turns actually cost.

- Both `Anthropic` and `Ollama` providers expose token usage on
  responses; capture into a per-turn `TokenUsage { input, output, cached }`
  block.
- Aggregate per session and persist to `~/.asterisk/usage.jsonl`.
- New `/cost` command (per-session + lifetime), new `/usage` command
  with day / week / month breakdowns.
- Telegram `/cost` for the bot side.
- Optional: alert hook when a session crosses a configurable threshold.

**Why:** hard to budget LLM use without visibility. Especially relevant
for users running paid Anthropic alongside local Ollama — they want to
know which calls hit the paid API.

### Streaming for the REPL
**Status:** infra exists, UI work remains · **Effort:** small-medium

Provider streaming already works (we wired it for Telegram stream mode).
The REPL still waits for `onAssistantText` per text block. Hook
`onAssistantDelta` into the Ink transcript so the REPL also types out
in real time. Same shape — just a different event sink.

## Tier 2 — Worth doing once Tier 1 settles

### `/doctor` diagnostics command
Health-check command. Probes:
- Provider reachability (Ollama up? Anthropic key valid?)
- Daemon status, log size, recent errors
- MCP server connection state, tool counts
- Disk: `~/.asterisk/` size, log rotation, old backup files
- Tools on PATH: `gh`, `git`, `bun`, `playwright`, `yt-dlp`, `gitleaks`,
  `trivy`, `cargo`, `go`, …

### Image content blocks for the model
Today the agent calls `BrowserScreenshot` and only sees the file path.
Pipe the actual image bytes back through Anthropic's vision-capable
content blocks (and Ollama's vision models when present) so the agent
can *read* its own screenshots.

### Model-side context compaction
The agent loop has a slot for it (history surgery before send). Not
implemented. Strategy: when input tokens cross a threshold, summarise
the oldest N tool-results into a single "summary" message and replace
them. Keeps long sessions usable.

### Ctrl+C abort in the REPL
`AbortSignal` plumbing already runs end-to-end (provider, retry, tools).
Hook a key handler in `src/repl/App.tsx` so Ctrl+C cancels the in-flight
turn cleanly instead of killing the whole process.

### Multi-agent coordinator mode
Today `Agent` is single-shot per call. Coordinator mode would let the
parent dispatch N agents and orchestrate them — fork-join semantics with
shared task list, results merged on collection. Like `batch` skill but
parallelised across actual sub-agents instead of sequential.

## Tier 3 — Speculative, not committed

### Web dashboard
Optional read-only dashboard at `localhost:<port>` showing daemon state,
per-chat conversation history, token usage, scheduled jobs. Single Bun
process, no extra deps. Off by default; opt-in via config.

### Voice IO
Speech-to-text on input, text-to-speech on output for the daemon (so a
phone can run an Asterisk session via Telegram voice messages). Punts on
wake-word; just a bot message handler that takes audio.

### Model-aware soul context
Today souls are static markdown. A "dynamic soul" would let a snippet
hook into the system prompt at compose time — e.g. "include current
calendar events" or "include the last 5 commits". Tradeoff: more
power, more sources of drift. Probably needs sandboxing.

### Conversation persistence
In-memory per-chat history is wiped on daemon restart. SQLite-backed
history with per-chat retention policies would survive restarts but adds
a real persistence dependency. Mostly worth it for serious bot use.

### Plugin lifecycle hooks
`before_turn` / `after_turn` etc. exist as shell-command hooks. A
TypeScript hook surface (load a `.ts` file, register a function) would
be more powerful but adds a security surface (arbitrary code load).
Probably needs a sandbox / permission model first.

---

## How priorities shift

If a Tier-2 item starts blocking real work, it gets promoted. If a
Tier-1 item turns out smaller than expected, it gets shipped. The
ordering reflects current judgement, not a contract.

If you want something not on this list: open an issue with the use case
(not just the feature name).
