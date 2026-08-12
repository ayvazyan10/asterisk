# Security

## Reporting vulnerabilities

If you find a security issue in Asterisk, please open a private security
advisory on GitHub rather than a public issue, or email the maintainers
directly.

We aim to acknowledge reports within 7 days and to issue fixes for
confirmed vulnerabilities in a reasonable time frame.

## Threat model

Asterisk is designed to run locally on a developer machine, with optional
exposure to remote chat platforms via opt-in bot adapters.

The security boundaries we care about:

1. **Filesystem access.** Tools (`Bash`, `Read`, `Write`, `Edit`) operate with
   the privileges of the user running Asterisk. Don't run Asterisk as root,
   and don't expose the daemon to untrusted users.
2. **Bot allowlists.** The Telegram adapter enforces an `allowedUserIds`
   allowlist; messages from non-allowlisted users are dropped. Configure this
   carefully — an empty allowlist with a public bot token means anyone who
   guesses the bot can send messages.
3. **Secrets.** API keys and bot tokens live in `~/.asterisk/asterisk.db`
   (mode 0600, and created 0600 *before* WAL is enabled so the `-wal`/`-shm`
   sidecars inherit the restriction — they hold a verbatim copy of every
   value written). A legacy `~/.asterisk/secrets.env` is still read as a
   fallback. Asterisk never logs or echoes secrets after the configure wizard
   reads them.
4. **Bash consent.** Commands the agent proposes are gated by
   `src/tools/bash-permissions.ts` before they run. This is a consent check,
   not containment: an approved command executes with your full privileges.
   Unattended runs (daemon, bots) answer from `permissions.headless`, which
   defaults to `deny`.
5. **Bash containment.** Where a backend is available — bubblewrap on Linux,
   seatbelt on macOS — the command additionally runs with `/` read-only and
   only the workspace, `/tmp` and configured paths writable. `~/.asterisk` is
   deliberately not writable, so a command cannot rewrite the secret store or
   its own permission grants. A backend is never trusted until it is probed
   with both a positive and a negative control, and is dropped to `none` if
   either says otherwise.

## Out of scope

- Confinement of anything other than `Bash`. `Read`/`Write`/`Edit` are
  in-process and bounded by the write policy, not by the sandbox; in-process
  plugins are not confined at all, which is why they are off by default and
  enabled path-by-path. Untrusted code belongs in an MCP server.
- Sandboxing on a machine with no backend available. `sandbox.mode: "auto"`
  runs unconfined when bubblewrap/seatbelt is missing or non-functional; set
  `"required"` to refuse instead. If you need hardening for untrusted
  prompts, run Asterisk inside a VM or container.
- Hardening of dependent libraries (Bun, `grammy`, `playwright`, etc.) beyond
  pinning known-safe versions.
