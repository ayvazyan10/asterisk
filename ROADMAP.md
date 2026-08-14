# Asterisk roadmap

Forward-looking work, ranked by priority within each tier. Items move from
here into commits as they ship.

## Tier 1

**Empty.** Everything the original Tier 1 named has shipped or been dropped,
including the OS-level sandbox and the write boundary for the in-process file
tools, and Tier 2 emptied behind it. Two things shipped in `0.4.0` that were
never on this list at all — an interface language and `RunCode` — which is a
sign the list had stopped describing the work rather than a sign the work was
unplanned.

What is left is Tier 3, which is speculative by construction. The honest
statement of priority for `0.4.x` is therefore not a feature: it is coverage,
and whatever the first outside users actually report. New items should arrive
from issues, not from this file.

`src/bots/telegram` was the surface this paragraph used to name at ~32%. All of
`src/bots` is done now — a fake Bot API drives the adapter, and `adapter.ts`,
`commands.ts` and `manager.ts` sit at 100% statements, functions and branches,
with `telegram/index.ts` at 98/94/96.

`src/web` was listed here as the other 0% hole. That was simply wrong —
`web.test.ts`, `web-panel.test.ts` and `web-origin-guard.test.ts` have had it
near 85% for some time. Its render layer was the thin part, and
`tests/web-ui.test.ts` now covers that. The one real gap left is
`src/tools/code` (~3%, the interpreter).

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

### ~~OS-level sandbox for Bash~~ ✓ shipped
`Bash` runs under bubblewrap on Linux and `sandbox-exec` on macOS: `/` bound
read-only, workspace and `/tmp` writable, fresh `/dev` and `/proc`, optional
network unshare. `~/.asterisk` is deliberately read-only, so a command cannot
rewrite the secret store or the permission grants that let it run.

The part worth keeping: **a backend is not trusted until it passes a
containment probe on the machine it is running on.** Asterisk tries a write
that must fail and drops to unconfined if it succeeds. The macOS profile in
particular cannot be exercised by CI, which is Linux-only, and a sandbox that
silently does not sandbox is worse than none — it converts caution into
confidence without converting any security.

Modes: `auto`, `required` (refuse to run at all when unconfined), `off`.

### ~~Extend the sandbox boundary to the in-process file tools~~ ✓ shipped
`Read`, `Write` and `Edit` execute inside the agent process, so no
child-process sandbox reaches them. They now share one policy module with the
shell: `sandbox.writablePaths` governs both, so widening the boundary for one
no longer silently leaves the other where it was.

They differ on `/tmp`, deliberately. The first cut unified them on the grounds
that refusing `/tmp` to `Write` only pushed the agent toward `Bash`. That was
wrong — `touch /tmp/x` is off the read-only allowlist, so the Bash route costs
an approval prompt and `Write` costs nothing. Unifying would have removed a
consent step, not an inconsistency.

Still true and still worth saying: a path check is a check, and bubblewrap is a
kernel boundary. Sharing the policy does not make the in-process tools as
strong as the sandboxed shell.

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

### ~~Image content blocks for the model~~ ✓ shipped
`BrowserScreenshot` now returns an image attachment, and the agent loop turns
it into a content block carried in the same user message as the tool results —
a separate message would put two user turns back to back, which the Anthropic
API rejects. Mapped per provider: Anthropic nests base64 under `source`,
Ollama takes an `images` array on the message, OpenAI-compatible endpoints take
a `data:` URI part. Each of those silently ignores a block it does not
recognise, so the mapping is the whole feature and it is tested per provider.

Capped by the `vision` settings — size, count per turn, and how many survive in
history, because one screenshot costs well over a thousand tokens and two can
outweigh an entire text conversation. Older images become a note naming what
was dropped.

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

### ~~Multi-agent coordinator mode~~ ✓ shipped as `AgentBatch`
Dispatches several sub-agents for one parent turn, results merged in input
order. Concurrency is derived rather than promised: worktrees are
process-global and sub-agents share the parent's tool state, so a batch
containing any agent type that can write runs sequentially. Tolerating `Bash`
in the read-only classification rests on the permission gate — its allowlist is
read-only commands and anything else needs approval.

Still open from the original sketch: a worktree per sub-agent, which needs
`activeWorktree()` to stop being process-global.

### ~~Persistent memory with FTS5~~ ✓ shipped
`Remember` / `Recall` over a `memories` table with an external-content FTS5
index, degrading to substring search where the SQLite build lacks FTS5. No
`Forget` yet, no dedupe, and memory is install-wide — two people talking to the
same bot share it.

### ~~A real SKILL.md contract~~ ✓ shipped
Frontmatter is validated against a schema derived from what the loader actually
consumes. `/skills validate` reports what failed to load and why; the 29
bundled skills are machine-checked.

### ~~Provider fallback chain~~ ✓ shipped
`providerFallback` is an ordered list of backends to try when the primary one
cannot answer. Only availability failures advance the chain; `bad-request`,
`context-overflow` and `aborted` describe the request rather than the backend,
and replaying them elsewhere would hide the real error behind a model switch.
Failover also stops once a reply has started streaming — the first half is
already on the user's screen. The chain advertises the smallest context window
of its links, because history is budgeted once and answered by whichever link
takes it.

### ~~Self-eval harness~~ ✓ shipped
`asterisk eval` runs scenarios against objective criteria — a file contains X,
a tool was called, the sequence was Edit→Read→Edit — rather than against
whether an answer reads well. Runs offline in CI with a scripted provider,
`--live` for a real model. A guard test requires every scenario to carry at
least one objective criterion, so a model-graded-only scenario cannot go
permanently green.

### ~~Local-model robustness~~ ✓ shipped
Fixed against a live llama.cpp server: tool calls emitted as text instead of
through the tool-call channel, a namespaced tool name the model invented for
itself, unparseable or prose-wrapped arguments, empty completions that were
pushing `content: []` into history, and runaway repetition. Ollama-side changes
are fixture-driven — Ollama was not running.

### ~~Agent Client Protocol server~~ ✓ shipped
`asterisk acp` speaks ACP over stdio so an editor can drive Asterisk.
Implements the documented core and answers method-not-found for the rest,
which the capabilities honestly advertise. Unproven against a real ACP client.

### ~~Plugin lifecycle hooks~~ ✓ shipped, with the prerequisite corrected
`before_turn` / `after_turn` etc. existed as shell commands; a TypeScript
surface now exists too. The note here said it "probably needs a sandbox /
permission model first" — having built both, that turned out to be the wrong
prerequisite. bubblewrap confines child *processes*; a plugin is a function
call, so it runs with the secret store, the tool registry and the permission
gate itself. Nothing changes that.

So the split is stated instead of engineered around: code you wrote or read is
a plugin, code you did not is an MCP server, where the isolation is that it is
a separate process. Off by default, every plugin named by path, no directory
scan.

### ~~Asterisk as an MCP server~~ ✓ shipped
`asterisk mcp-server` serves memory as tools, skills as prompts and rules as
resources. Bash, Write, Edit and a full agent turn are deliberately absent:
Bash's boundary is a consent prompt with a human behind it, and Write/Edit are
bounded by a workspace guard rooted at a cwd the *client* chooses.

### ~~REPL test coverage~~ ✓ shipped
`src/repl` from 7.45% to 77.14%, repo-wide lines 50 → 65, no new dependency.
Found a stray character typed by Ctrl+O and a set of dead duplicate handlers.

## Tier 3 — Speculative, not committed

### ~~Web dashboard~~ ✓ shipped as the control panel
Promoted to Tier 1 and shipped read-write — see above. Still outstanding
from the original sketch: per-chat conversation history and token-usage
views, which land with the cost-tracking work.

### Voice IO
Speech-to-text on input, text-to-speech on output for the daemon (so a
phone can run an Asterisk session via Telegram voice messages). Punts on
wake-word; just a bot message handler that takes audio.

### A second bot transport
WhatsApp was removed in `0.4.0` — the official path needed a Business Manager
account, the unofficial one violated WhatsApp's ToS — which leaves Telegram
as the only bridge. The adapter contract in `src/bots/adapter.ts` survived
the removal intact, so Matrix, Discord, Signal or a plain webhook are each a
self-contained module. None is committed; the question is which one a real
user asks for.

### Model-aware soul context
Today souls are static markdown. A "dynamic soul" would let a snippet
hook into the system prompt at compose time — e.g. "include current
calendar events" or "include the last 5 commits". Tradeoff: more
power, more sources of drift. Probably needs sandboxing.

### ~~Conversation persistence~~ ✓ shipped
JSON-file based persistence in `~/.asterisk/conversations/`. Daemon
auto-saves after each turn, restores on chat reconnect. 7-day expiry.



---

## How priorities shift

If a Tier-2 item starts blocking real work, it gets promoted. If a
Tier-1 item turns out smaller than expected, it gets shipped. The
ordering reflects current judgement, not a contract.

If you want something not on this list: open an issue with the use case
(not just the feature name).

---

## Plugins: from three methods to a real contract

Requested work, not speculation, so it sits outside the tiers above.

### The problem, stated once

A plugin is **trusted by construction**. That is the entire reason MCP exists
beside it: code you did not write becomes an MCP server, where the isolation is
that it is a separate process, and code you did write becomes a plugin, where
there is no isolation at all. `src/plugins/types.ts` argues that position and it
is right.

But the contract does not follow from it. The process offers a plugin
everything — the SQLite store with the keys, the tool registry, the permission
gate. The API offers three methods: `registerTool`, `on`, `log`. So the moment a
plugin wants to do anything real it reaches around the contract into Asterisk's
own modules, and becomes a private fork that breaks on the next refactor.

The work is to make the *contract* as capable as the *process* already is, and
to make it something a plugin can depend on across versions. Not to make plugins
safer — they cannot be made safer in-process, and pretending otherwise is how
you end up with a sandbox that does not sandbox.

### Tier A — the contract

Everything else depends on this, and it is a breaking change to the plugin
shape. Do it now, while the number of third-party plugins is zero.

**A1. Manifest and version compatibility.** A plugin declares `apiVersion` and
the Asterisk range it was written against. A mismatch is refused by name at load
time rather than misbehaving at run time. Today a plugin written for `0.4`
silently does the wrong thing on `0.6`.

**A2. A real `PluginApi`.** Replace the three methods with a surface that covers
what a plugin actually needs:

| Method | Why it is not optional |
|---|---|
| `config()` | Read the resolved config. Plugins currently import `loadConfig` themselves. |
| `settings` | Namespaced key/value in the DB, scoped to the plugin. Today a plugin needing state invents a file. |
| `secret(name)` | Gated on a manifest declaration, so the panel can say what a plugin asked for. |
| `invokeTool(name, input)` | Compose with the built-ins instead of reimplementing them. Goes through the same registry, so every gate still fires. |
| `registerCommand(cmd)` | See B1. |
| `log` / `logger` | Structured, into the daemon log, not just the transcript. |

**A3. `activate` / `deactivate`.** Loading is currently one-way. Reload, per-plugin
disable and clean shutdown all need a plugin to be able to give its resources
back.

**A4. Declared capabilities.** The manifest lists what the plugin registers and
what it wants — tools, commands, events, secrets. This is **disclosure, not
enforcement**: nothing can stop in-process code, but the panel can show what a
plugin claims it will do *before* you turn it on, which is the decision that
actually matters.

### Tier B — reach

**B1. Slash commands.** The REPL is command-driven and plugins cannot add one.
`COMMANDS` is already an array in `commands/registry.ts`; the visual `FormSpec`
/ `ListSpec` contract is already the return type. This is the cheapest large win
on the list.

**B2. System-prompt contribution.** Rules, skills and souls are all composed at
prompt time. A plugin should be able to contribute a fragment — that is what
"dynamic souls" in Tier 3 above actually wants, and it needs no sandbox because
plugins are already trusted.

**B3. Provider middleware.** Wrap the model call: response caching, prompt
redaction, routing a class of turn to a different model. `providers/factory.ts`
is already the single place a provider is built, so the seam exists.

**B4. Scheduled work.** The daemon has a scheduler. A plugin should be able to
ask for a periodic callback without spawning its own timer that nothing can see
or stop.

**B5. Transport and context hooks.** Bot message in/out, and a hook on context
compaction — the summariser is the place a plugin could keep its own state
across a compaction rather than losing it.

### Tier C — operations

**C1. The runtime report reaches the panel.** The Plugins page reads
configuration and says plainly that it cannot know what is loaded, because the
panel is not the process that loads plugins. Fix: the daemon writes its load
report — loaded, failed, tools, handlers — to the database at startup, and the
page reads it with the timestamp attached. Small, and it removes the one honest
gap on that page.

**C2. Hot reload.** `initialisePlugins()` already replaces the set rather than
appending, so the hard half is done. Needs A3 to be real, or reload leaks
whatever the old set held.

**C3. Per-plugin enable.** One global switch means testing one plugin costs you
all of them.

**C4. Ordering and collisions.** Handlers run in load order and the first
`block` wins; two plugins registering the same tool name resolve by "last one
shadows", silently. Both should be declared and both should be visible.

**C5. Error budget.** A handler that throws is currently reported and ignored —
every single turn. A plugin that fails repeatedly should be disabled for the
session with one line saying so.

### Tier D — authoring

**D1. A typed entry point.** One `asterisk/plugin` export so a plugin imports
its types from a stable path instead of reaching into `src/`.

**D2. Scaffold and test harness.** `asterisk plugin new`, plus an in-repo helper
that runs a plugin against a fake agent loop. Without this, testing a plugin
means booting the whole product.

**D3. Reference plugins.** Two or three in-repo, tested, that exercise the API
end to end — the honest check on whether A2 is actually sufficient.

**D4. Distribution.** Last, deliberately. Nothing should be shareable until the
API has survived D3, and the answer is probably "an npm package named by path",
not a registry.

### Not doing

- **Sandboxing plugins.** Already argued in `types.ts`: bubblewrap confines
  child processes, and a plugin is a function call. The isolated mechanism is
  MCP, and Asterisk already speaks it.
- **A directory scan.** Dropping a file into a folder must never be enough to
  get code into this process.
- **Auto-update of plugins.** Code that updates itself with your keys in reach
  is not a feature.
- **A marketplace before D3.** A published API that turns out to be wrong is
  worse than no API.

### Sequence

A → C1 → B1 → the rest by demand. A is breaking and must land first. C1 is a
day's work and closes the gap the Plugins page currently has to apologise for.
B1 is the largest capability increase per line of code on the list.
