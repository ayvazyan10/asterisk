# Asterisk roadmap

Forward-looking work, ranked by priority within each tier. Items move from
here into commits as they ship.

## Tier 1

The original Tier 1 has shipped or been dropped. What remains at this tier is
the **OS-level sandbox** below — the permission boundary that shipped covers
consent, not containment. After that, the next items to promote come from
Tier 2: image content blocks and the multi-agent coordinator.

### ~~Skill marketplace~~ — dropped
Cut on 2026-07-31. The bundled set stays the whole story; skills are still
authored by hand in `~/.asterisk/skills/` or through the web panel's editor.
Design notes kept below for anyone who wants to revive it.

<details>
<summary>Original design</summary>

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

</details>

### ~~Token / cost tracking~~ — shipped, then removed
Shipped as `/cost`, `/usage`, a Telegram command and a web panel tab, then
removed wholesale in `bdbd2b7` along with the `usage` and `model_pricing`
tables (migration 3 drops them). The numbers were estimates dressed as
accounting: local models are free, hosted rates drift, and nothing in the
product acted on the figure. Not planned for return.

### ~~Bash permission boundary~~ ✓ shipped
The Bash tool now runs read-only commands directly and asks the user about
everything else. Commands are split into the segments bash would actually
run before any rule is consulted, so a chained command is judged as a whole
and constructs that defeat static analysis — command substitution, variable
expansion, here-docs, subshells, redirection to a real path — are never
auto-approved. `permissions.mode` picks between `ask`, `allowlist` and
`unrestricted`; unattended runs answer from `permissions.headless`, which
defaults to refusing. Manage it with `/permissions`.

This is a consent boundary and nothing more. See **OS-level sandbox** below
for the half that is still open.

### OS-level sandbox for tool execution
**Status:** not started · **Effort:** large

The permission gate decides *whether* a command runs. Nothing constrains
what it does once approved, and `Read` / `Write` / `Edit` bypass the gate
entirely because they execute in-process — only the workspace guard bounds
them, and `ASTERISK_NO_WORKSPACE_GUARD=1` turns that off.

A real boundary needs a kernel-level backend: `bubblewrap` on Linux,
`sandbox-exec` (seatbelt) on macOS, with `none` as an explicit opt-out and
graceful degradation when neither is installed. Read-only bind of `/`,
writable binds for the workspace plus `~/.asterisk/outputs` and a temp dir,
and an optional network unshare. The in-process file tools need a path
policy over the same rules, since no child-process sandbox can cover them.

### ~~Streaming for the REPL~~ ✓ shipped
Provider streaming wired into the REPL transcript via `onAssistantDelta`.
Tokens land in a single self-updating assistant entry. Working
indicator surfaces character counts when no tools have fired yet so
long generations don't look like a hang.

### ~~SQLite-backed settings + web control panel~~ ✓ shipped
Configuration moved out of `config.json` and into `~/.asterisk/asterisk.db`
(`bun:sqlite` under Bun, `node:sqlite` under Node — no new dependency). The
settings form is **generated from the Zod schema** via `config/introspect.ts`,
so a new field in `ConfigSchema` appears in the browser with the right widget
and bounds without touching UI code. `asterisk web` serves a full control
panel: settings, secrets (masked), MCP servers, hooks, a markdown editor for
rules/skills/agents/souls, daemon start/stop, diagnostics, log tail, audit
trail and token management. `config.json` survives only as an import/export
format and is absorbed on first run.

## Tier 2 — Worth doing once Tier 1 settles

### ~~`/doctor` diagnostics command~~ ✓ shipped
Checks Ollama/Anthropic connectivity, system tools (git, rg, bun, node,
playwright), MCP servers, config files, daemon status.

### Image content blocks for the model
Today the agent calls `BrowserScreenshot` and only sees the file path.
Pipe the actual image bytes back through Anthropic's vision-capable
content blocks (and Ollama's vision models when present) so the agent
can *read* its own screenshots.

### ~~Model-side context compaction~~ ✓ shipped
`compactHistory()` runs at the top of each turn against a budget of 60% of
the window the active provider reports, compacting old tool results and long
text blocks while keeping the 6 most recent messages intact. The original
hard-coded 80k threshold sat above Ollama's default 65,536 window, so on a
stock install the feature could never fire; `53ce875` fixed that.

### ~~Summarise dropped history instead of only counting it~~ ✓ shipped
When shortening is not enough and messages have to go, the dropped span is now
replaced by a summary the model writes of it, rather than
"[N earlier message(s) dropped]". A long session used to lose the decisions
that shaped it — which approach was rejected and why, the paths already
touched — and the model would re-derive them wrongly and confidently.

One model call, made only when messages are genuinely being discarded;
shortening alone never triggers it. Every failure path returns null and falls
back to the plain notice, because a summary is an improvement on dropping, not
a precondition for it. Off via `summariseDropped: false`; sub-agents opt out
already.

### ~~Token counting for the compaction budget~~ ✓ shipped
`agent/tokens.ts` replaces `chars / 4` with a character-class model. The old
estimate reported Chinese at 0.27x its real size, so a CJK conversation
overflowed the window with compaction never firing; JSON came in at 0.68x and
emoji at 0.50x. Everything now lands between 0.9x and 1.3x.

Not a tokenizer, deliberately. Asterisk talks to three vendors with three
vocabularies, and none exposes a counter cheaply enough to run over the whole
history every turn — llama.cpp's /tokenize is a round trip, Anthropic's
count_tokens is billable, Ollama has none. A bundled BPE table would be
precise for one vendor and wrong for the other two.

### ~~Ctrl+C / ESC abort in the REPL~~ ✓ shipped
ESC key aborts in-flight turns, clears the message queue. AbortSignal
plumbing was already end-to-end; wired via `useInput` in App.tsx.

### Multi-agent coordinator mode
Today `Agent` is single-shot per call. Coordinator mode would let the
parent dispatch N agents and orchestrate them — fork-join semantics with
shared task list, results merged on collection. Like `batch` skill but
parallelised across actual sub-agents instead of sequential.

## Tier 3 — Speculative, not committed

### ~~Web dashboard~~ ✓ shipped as the control panel
Promoted to Tier 1 and shipped read-write — see above. Still outstanding
from the original sketch: per-chat conversation history and token-usage
views, which land with the cost-tracking work.

### Voice IO
Speech-to-text on input, text-to-speech on output for the daemon (so a
phone can run an Asterisk session via Telegram voice messages). Punts on
wake-word; just a bot message handler that takes audio.

### Model-aware soul context
Today souls are static markdown. A "dynamic soul" would let a snippet
hook into the system prompt at compose time — e.g. "include current
calendar events" or "include the last 5 commits". Tradeoff: more
power, more sources of drift. Probably needs sandboxing.

### ~~Conversation persistence~~ ✓ shipped
JSON-file based persistence in `~/.asterisk/conversations/`. Daemon
auto-saves after each turn, restores on chat reconnect. 7-day expiry.

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
