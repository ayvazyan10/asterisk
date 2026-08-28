# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-29

### Added

- **Tool schemas are loaded on demand instead of resent every turn.** Measured
  on a live install with Notion, GitHub and engram connected: 148 registered
  tools carrying 206.7 KB of JSON schema — about 60k tokens — into every single
  request, before the user had typed anything. A one-word "hello" cost 68k
  tokens of prompt and nine to seventeen minutes of prompt-eval on a local
  llama.cpp. Every turn. `ToolSearch` now does what the docs always claimed it
  did: MCP tools travel as a one-line pointer (how many, from which server) and
  `ToolSearch` returns a matching tool's full definition and makes it callable
  from the next message onwards. The same inventory now costs 24.9 KB / ~7.3k
  tokens by default. Nothing is unregistered and no gate moved — dispatch, the
  bash gate, write policy, plan mode and `allowedTools` all see the same
  registry they always did. `tools.deferSchemas` sets the policy: `mcp`
  (default) keeps every built-in listed, `all` also defers the long tail of
  built-ins for ~2.9k tokens total, `off` restores the previous behaviour.

### Security

- **Two spellings walked a forbidden argument past the Bash consent gate.**
  `FORBIDDEN_ARGS` bans `git -c` because a git config names programs to run,
  but `$'…'` was invisible to the tokenizer — `find . $'-\x65xec' …` never
  matched `/^-exec/` while bash expanded it to `-exec`, and evaluated to
  `allow` even under `allowlist`. Leading `VAR=value` was stripped without
  looking at the name, so `GIT_EXTERNAL_DIFF=… git diff` was judged as bare
  `git diff`; that was demonstrated executing an arbitrary script with no
  prompt. Both now make the segment opaque, which is the answer the module
  already gave anything it could not resolve statically. A name denylist
  cannot work here — the next variable name is always free.
- **Read-only promises that were not.** `sort --compress-program`,
  `git diff --output`, `tree -o`, `date -s`, `git --config-env`/`--git-dir`,
  `--devices` on egrep/fgrep, and uniq's positional OUTPUT operand all ran
  programs or wrote files from commands the allowlist called safe.
- **"Always allow" on a flag-led command remembered the bare binary.** One
  press on `node -e "console.log(1)"` left a standing grant for any `node -e`;
  `bash -lc "make"` granted `bash`. Deny now also matches basenames and
  `command`/`builtin`/`exec` wrappers, so a ban reaches the spellings it has
  to; allow stays exact, and `./git` still cannot claim the `git` rule.
- **Every containment check compared the wrong path.** `resolve()` does not
  follow symlinks and `writeFile` does, so a `link -> ~/.ssh` inside the
  workspace made `<workspace>/link/authorized_keys` writable by Write and
  Edit, which run in-process and are not covered by the sandbox. The panel's
  own check climbed to the deepest *existing* ancestor with `existsSync`,
  which follows the link and returns false for a dangling one, so a dangling
  symlink wrote outside the tree; `/api/skills` had no check at all.
  Containment now lives in `fs-safe.ts` and walks the links itself.
- **The SSRF guard ignored the DNS root dot.** `localhost.` and
  `metadata.google.internal.` — the GCP metadata address the module exists to
  block — passed while the resolver accepted them.
- **The panel token was passed to `xdg-open` on the command line**, where any
  local user reads it from `/proc/<pid>/cmdline` and the browser keeps it in
  history. The browser now gets a separate single-use token, revoked seconds
  later.
- **The origin guard compared hostnames, not origins.** A page served from any
  other loopback port passed it — a dev server on `127.0.0.1:3000` could `PUT
  /api/hooks` with credentials, and `hooks.command` is executed through
  `bash -lc`. Only `Sec-Fetch-Site` stood in the way.
- **The OAuth callback skipped its CSRF check before the state was known**,
  which is a real window: the fixed-port listener starts before the SDK has
  generated the state, with discovery and possibly dynamic registration in
  between.

### Fixed
- **Cron fired the same job again while it was still running.** `lastRunAt`
  was written only after every dispatch had awaited, while the one-shot block
  directly above writes before its loop — that asymmetry was the bug. A job
  whose turn outlasted a 30s tick fired again, and a `* * * * *` job whose
  turn ran fifteen minutes fired on every tick throughout. Measured at a 10ms
  interval with a 200ms dispatch: 20 dispatches before, 1 after.
- **One unreadable file in `~/.asterisk/agents` took down every entrypoint.**
  `loadAgents` runs at module load through the Agent tool's description, and
  stats inside a readdir loop with no `try`/`catch`, so a dangling symlink
  made `asterisk --help` die with ENOENT before the REPL drew. `loadRules`
  has the same shape but runs per turn, so every message after that answered
  with a bare ENOENT instead of a reply. `skills/loader.ts` has done this
  correctly all along; agents and rules now do too, and name the file that
  failed instead of swallowing it.
- **Edit destroyed files it could not read.** It decoded every file as UTF-8
  and wrote the whole thing back, so one `VERSION=1.0.0` → `2.0.0` on a file
  holding any invalid byte replaced every one of them with U+FFFD across the
  entire file, grew it from 30 to 48 bytes, and returned success. It now
  refuses and touches nothing. Edit also could not match a multi-line block in
  a CRLF file, because Read displays lines split on `\n` with an invisible
  `\r` left on each.
- **Grep returned rg's error text as a search result.** The pattern was passed
  positionally with no `--`, so `-foo` was read as a flag: rg parsed it as
  `-f oo`, exited 2, and the tool answered `ok()` with the error inside.
- **Parallel tool calls collapsed into one on the non-streaming path.**
  `ToolCallBuffer` keyed by `delta.index ?? 0`, and a non-streamed reply's
  `tool_calls` carry no index — three calls came back as one, id and name from
  the last, arguments concatenated then read as the first. That path is
  subagents, cron turns and the eval runner; two Edits in one turn silently
  lost the second.
- **Compaction had a fixed point.** Large error results were never persisted
  and the six most recent messages could be neither shortened nor dropped, so
  one 60KB MCP error left the history permanently over budget — five passes
  returned the same size, and the daemon had already written it to disk for
  `/resume` to restore. The protected tail is now protected from being
  dropped, not from being shortened.
- **A stalled stream escaped as a bare `Error`** — not retryable, not a
  `ProviderError` — so the turn died as `unknown-error` and never stepped down
  the chain. Both branches now classify by source: the caller's signal is
  `aborted`, our own deadline is `unresponsive`, which fails over without
  retrying a backend that has been silent for ninety seconds.
- **Migration 9 left a duplicate behind.** It removed `'ollama'` from
  `providerFallback` with `json_remove` on one computed index, `LIMIT 1`, run
  once, while its comment promised "wherever it appears". A list holding it
  twice kept one, which then failed the enum on every `readConfig` from every
  entrypoint, with no way back. Migration 10 rebuilds the array with a filter.
- **A malformed `config.json` wedged startup permanently.** The import threw
  before `writeConfig`, so settings stayed empty, the migrated flag never
  became true, and the file was never renamed — every later start failed
  identically. It is quarantined as `config.json.broken` now.
- **stdio MCP servers were orphaned on every quit.** Shutdown ran from
  `process.on('exit')`, which must be synchronous, so the SIGTERM never went
  out. Observed in the wild: two orphans spinning at 100% CPU each.
- **The REPL queue stalled on a slash command**, which never touches `busy`,
  so a queue holding one in the middle kept its remaining items while the UI
  went on counting them.
- **Telegram left answered approval buttons live** — `editMessageText` passed
  no `reply_markup`, against the comment above it promising otherwise — and
  chunked rendered HTML blindly at 4096, shipping half a tag that Telegram
  rejects and `stripTags` cannot repair.
- **`/style` wrote the shared daemon config**, so one allowlisted user changed
  every other chat's output style. It is per-session now, like `/soul` beside
  it.
- **`ASTERISK_LANG` meant two incompatible things.** The rules loader read it
  as the project's language, i18n as the interface locale, so setting it to
  `ru` for a Russian interface silently turned the per-language rule layer off.
  Locale moves to `ASTERISK_LOCALE`; the old name keeps working one more
  release, with a warning.
- **The embedded interpreter ignored its own limits.** `sort()` handed the
  array to the host's sort, which charges no steps and never checks the clock
  or the signal: eight of them ran 5.3s against a 1s deadline, reported
  success, and blocked the event loop so completely that an abort scheduled at
  50ms only ran afterwards. Ten silently-wrong semantics went with it —
  `break` outside a loop finishing the program successfully, `for (let x of …)`
  binding as const, compound assignment evaluating its target twice and so
  running a tool call twice, `some`/`every` not short-circuiting, `0b1010`
  parsing as 0.

- **The control panel says which model is answering.** The header chip read
  `(auto-detected)` on every page: it took the model from the config field that
  0.4.2 deliberately left blank, while the endpoint next door already asked the
  server. It now reports the detected model, a pinned one as pinned, or plainly
  that nothing could be detected — never a placeholder that looks like a name.
  The Overview figure's provider spoke stopped truncating mid-word, and the
  Connectors count appears on first paint instead of after the tab is first
  opened. "Connected" is now one rule, read by both the sidebar and the
  Connectors page, rather than two encodings that could disagree.
- **The Overview figure is operable from the keyboard.** Its spokes were
  focusable but nothing activated them: an SVG `<g>` synthesises no click from
  Enter, and the client had no `keydown` handler at all. Above 820px that figure
  *is* the navigation, so a keyboard user could not reach Settings, MCP, Hooks,
  Rules or Skills through it. Enter and Space now work, and the spokes carry the
  role that earns both.
- **Muted text meets WCAG AA.** Log timestamps and levels, the hint under every
  setting, list descriptions, breadcrumbs and sidebar counts sat between 2.6:1
  and 3.4:1 against a 4.5:1 floor, in both themes; form-control borders sat near
  1.4:1 against a 3:1 floor. Measured in the browser, not from the tokens.
  The primary button's fill needed a token of its own — as a fill under white it
  must be darker than it is as text on the page, and in dark theme no single
  value cleared both roles.
- **The Rules page stopped crying wolf.** It opened with 55 files under a red
  mark on a red-tinted row — the treatment a genuine misconfiguration gets — and
  the 22 rules actually in effect sat below them, under the fold. Those 55 are
  rules for other languages, inert *by design* in a TypeScript project. What is
  in effect now comes first; what is dormant collapses into one line naming the
  count and the reason. The distinction travels as data from the API rather than
  being recovered by matching the wording of a human-readable sentence, so
  rephrasing that sentence cannot silently turn 55 non-events back into errors.
- **The panel has a document structure.** There was no `<h1>` anywhere in the
  authenticated app and no list markup at all: every collection was a stack of
  `div`s, so nothing announced "list of 27". Page titles are `h1`, cards `h2`,
  and the collections that are collections say so — while Overview's four unlike
  facts deliberately stay unwrapped. `aria-current` carries `page`, WAI-ARIA's
  token for the current entry in a navigation, and is omitted rather than
  written as the string `"false"` on every other row. The stylesheet now keys
  those highlights off the attribute's presence, so the correct token can never
  again cost the active row its styling.
- **A form that rejects your input says so, and keeps saying so.** Settings and
  the MCP, Hooks, Skills and Connector add-forms marked nothing and moved focus
  nowhere; the only feedback was a toast that erased itself after eight seconds.
  Each field now carries a message tied to it by `aria-describedby` that
  survives the toast and clears when the value becomes valid, a failed submit
  moves focus to the first offending field, and an error toast interrupts
  (`role="alert"`) where a success toast does not.
- **The panel fits a phone.** Skills and Agents overflowed the viewport by ~200px
  at 375px, cutting text mid-word into a dead gutter, because a grid item's
  automatic minimum was its unbroken min-content width. The rail, which ate 42%
  of a phone screen with no way to collapse it, is a scrolling strip below 640px.
  Touch targets reach 44px on coarse pointers and narrow viewports without
  loosening desktop density, and a log line gives its message the full width
  instead of spending half of it on fixed time and level columns.

- **A tool schema no longer takes the whole turn down on llama.cpp.** With
  `--jinja`, llama-server compiles every tool's JSON Schema into a GBNF grammar
  for constrained decoding, and two keywords in that path each fail the entire
  request — all 139 tools, not just the one carrying the schema — with
  `Failed to initialize samplers: failed to parse grammar`. A `pattern` nested
  under an object property makes the regex→GBNF conversion emit `"\d"` inside a
  quoted literal, which llama.cpp's own grammar parser then rejects as an
  unknown escape; a large `maxLength` makes it expand the bound into that many
  repeated rules and blow its own complexity ceiling. Both were reached in
  practice through Notion's MCP tools, whose date properties carry leap-year
  ISO-date regexes. `pattern`, `minLength`, `maxLength`, `minItems` and
  `maxItems` are now stripped from the schemas sent to an OpenAI-compatible
  endpoint. All five are validation-only — none of them describes what a
  *correct* tool call looks like — and `enum`, `const`, `format`, `minimum` and
  `maximum` are deliberately kept, having been probed against the same server
  and found blameless. The Anthropic provider is untouched: it compiles no
  grammar and loses nothing by keeping them.

### Changed

- **`@anthropic-ai/sdk` 0.30.1 → 0.122.0.** `APIError.headers` is a web
  `Headers` now, so `headers['retry-after']` had been returning undefined and
  the server's own backoff hint was silently dropped on every 429; the same
  re-read found that `APIUserAbortError` was being classified as network and
  retried. `cache_control` moved into the stable types.
- **Playwright is an optional peer dependency**, so installing the package no
  longer pulls the drivers. Missing Playwright degrades to eight failing
  browser tools naming the install command, not a broken CLI.
- **`bun audit` reports zero vulnerabilities**, down from 52 (17 high). None
  needed an upstream fix — every patched version was already inside the range
  its parent declared, and the lockfile was holding old resolutions.
- **The published package is 2.2 MB packed, 7.3 MB unpacked**, down from
  6.5 MB and 22 MB. The nine entrypoints shared nearly their whole graph and
  each inlined its own copy; `splitting: true` puts it in shared chunks. The
  build wipes `dist/` first, since chunk names are content-hashed.

## [0.4.2] - 2026-08-27

### Removed

- **The Ollama provider.** Ollama serves an OpenAI-compatible API of its own,
  so the dedicated `/api/chat` path was a second implementation of something
  the project already had — and second implementations drift: its `think` flag
  was silently dropped on one call path for a while. `openai-compatible` is now
  the only local backend and the default, covering llama.cpp, LM Studio, vLLM,
  Jan, LocalAI, and Ollama itself at `http://127.0.0.1:11434/v1`. Anthropic is
  unaffected.
- Migration 9 rewrites `provider: "ollama"` to `openai-compatible`, drops the
  orphaned `ollama.*` settings, and removes `ollama` from `providerFallback`.
  The base URL is deliberately not carried over: Ollama's OpenAI-compatible API
  lives on a different port and path, and a copied value would point the agent
  at nothing while looking configured.
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

### Added

- **The active model is detected rather than configured.** Before each request
  the local provider asks `GET /v1/models` which model the server is holding
  and uses that, cached for a minute. Swapping the model on the server needs no
  config change, and a name written months ago cannot keep being sent to a
  server that no longer has it. `openaiCompatible.model` becomes a pin for the
  case where one endpoint serves several models; `/model auto` clears it.
- The same listing carries `meta.n_ctx`, so compaction now budgets against the
  window the server was actually started with. It used to assume 128k, which
  wasted more than half of a 262 144-token window and overflowed an 8 192-token
  one before compaction ever fired.
- `/doctor` and the panel's diagnostics report which model is answering and at
  what context window, instead of only whether a port was open.
- **Voice messages are transcribed.** A Telegram voice note is downloaded by
  the transport, turned into text by the core, and reaches the agent labelled
  as speech rather than disguised as typed text — the difference decides
  whether "I didn't catch that" is a sensible reply. The recording is deleted
  once read, and a failure is reported to the agent with its reason instead of
  vanishing. Two backends behind one `stt` config section: a local command
  template (`{input}`, `{model}`, `{language}`, `{output_dir}`) for
  whisper.cpp / whisper-ctranslate2 / any script, and any OpenAI-compatible
  `/audio/transcriptions` endpoint for Groq, OpenAI or a local whisper server.
  `auto` prefers the local command; a pinned backend is never silently swapped
  for the other, because that would decide on the user's behalf whether their
  voice leaves the machine. New secret `ASTERISK_STT_API_KEY`.
- **`Transcribe` tool** — the same pipeline for the agent, over any audio file
  it has a path to, with per-call `language` and `model` overrides.
- Spoken input never runs a bot slash command: a transcript that happens to
  start with "/" is a sentence Whisper heard, not a command the user typed.
- **Permission prompts in the chat.** A bot turn that needs a decision now asks
  in the chat that raised it, with allow-once / always / deny buttons, instead
  of being refused on the spot. `permissions.mode` defaults to `ask` and nothing
  in the daemon could ask, so every command outside the allowlist came back as
  the headless refusal — which reads as "your policy blocked it" rather than
  "you were never asked". Only a user on the transport's allowlist may press a
  button (a group chat contains anyone), an unanswered question is denied when
  `permissions.timeoutSeconds` elapses, and a transport that cannot deliver the
  question denies rather than throwing. New setting `permissions.chatApprovals`
  (default true) turns it off.
- Approval requests carry the session that raised them, and a UI subscribes for
  the sessions it can actually reach. The daemon serves many chats from one
  process, so "is anyone there" is now asked about the running turn rather than
  about the process; scheduled runs (`scheduled:<source>`) stay unattended and
  keep falling back to `permissions.headless`.

### Fixed

- **Voice notes reach a hosted transcriber under a name it accepts.** Telegram
  names voice messages `.oga`; Groq's accepted-format list has `ogg` and not
  `oga`, so every voice message would have come back as a format error the
  moment the HTTP backend pointed at a hosted service. Only the filename in the
  multipart part is normalised (`.oga`/`.opus` → `.ogg`) — the bytes are sent
  untouched, and the decoder reads the container, not the name.
- **A Telegram turn no longer blocks the update it is waiting for.** grammy's
  built-in polling processes updates one at a time (`handleUpdates` in bot.js:
  "handle updates sequentially (!)"), and the message handler awaited the whole
  agent turn — so a turn that asked for permission held the update stream while
  waiting for a button press that could not be delivered. The prompt sat there
  with its spinner until the policy timed out and denied a command the user had
  already approved. Turns now run off the update stream; ordering is unaffected,
  because the daemon already queues turns per chat.

### Changed

- **`asterisk web` starts in the background.** It prints the panel's URL — with
  the first-run token when one is minted — and hands the terminal back; the
  server itself runs as a detached child. Previously it held the terminal until
  Ctrl+C, so leaving the panel up meant `nohup … &`, and freeing the port meant
  finding the pid by hand. `asterisk web stop` now terminates it and releases
  the port. `--foreground` keeps the old blocking behaviour, which is the shape
  systemd and containers want.
- `permissions.timeoutSeconds` may now go up to 600. The old 110 cap was
  justified by the agent loop's 120s tool deadline, but Bash is an `interactive`
  tool and has had a 15-minute deadline all along — the cap was enforcing a
  limit that did not apply, and 110s is short for answering from a phone.
- The panel gets its own process state, separate from the daemon's:
  `~/.asterisk/web.pid`, `~/.asterisk/logs/web.log` and `~/.asterisk/web.json`
  (pid, host, port and URL of the running instance — never a token, since only
  token hashes are stored). Separate on purpose: `asterisk stop` must not take
  the panel down, and `asterisk web stop` must not stop the bots.

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

[0.5.0]: https://github.com/ayvazyan10/asterisk/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/ayvazyan10/asterisk/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/ayvazyan10/asterisk/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ayvazyan10/asterisk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ayvazyan10/asterisk/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ayvazyan10/asterisk/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ayvazyan10/asterisk/releases/tag/v0.1.0
