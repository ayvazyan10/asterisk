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
3. **Secrets.** API keys and bot tokens live in `~/.asterisk/secrets.env`
   (chmod 600). Asterisk never logs or echoes secrets after the configure
   wizard reads them.
4. **WhatsApp web-js transport.** This adapter logs in as a real WhatsApp
   account and **violates WhatsApp's Terms of Service**. We document it for
   personal use only; using it commercially or at scale will get the number
   banned. The official transport (`meta-cloud`) is the recommended path.

## Out of scope

- Sandboxing of `Bash` tool output. Tool calls run with the user's shell;
  there is no syscall filter, container, or seccomp profile. If you need
  hardening for untrusted prompts, run Asterisk inside a VM or container.
- Hardening of dependent libraries (Bun, `whatsapp-web.js`, `grammy`, etc.)
  beyond pinning known-safe versions.
