# Contributing to Asterisk

Thanks for your interest. This guide covers the dev setup and the rules of
engagement for code contributions.

## Setup

```bash
bun install
bun run typecheck
bun run test
bun run build
```

Run the REPL against a local model server:

```bash
./bin/asterisk
```

## Tooling

| Concern  | Tool                       |
| -------- | -------------------------- |
| Runtime  | Bun ≥ 1.1                  |
| Language | TypeScript (strict)        |
| Lint     | Biome (`bun run lint`)     |
| Format   | Biome (`bun run format`)   |
| Tests    | Vitest (`bun run test`)    |
| Build    | `bun scripts/build.ts`     |

Every PR should pass `bun run typecheck && bun run lint && bun run test`.

## Code style

- Small, focused files — under ~400 lines preferred, 800 lines hard cap.
- Strict TypeScript; no `any` unless you justify it in a comment.
- No mutation of caller-provided objects when reasonably avoidable.
- Validate at boundaries (config, message payloads, tool inputs) with Zod.

## Commit messages

Conventional commits:

```
feat(bots): add SMS adapter
fix(daemon): handle PID race on rapid restart
refactor(config): collapse load+save into one module
```

## Testing

- Co-locate tests under `tests/<area>.test.ts`.
- Prefer integration-style tests that exercise the public surface (the
  daemon-lifecycle and Meta Cloud webhook tests are good examples).
- Use real temp directories via `mkdtemp` — never reuse `/tmp/asterisk-*`.

## Provenance — non-negotiable

Asterisk is a clean-room project. Contributors must not paste source
code from non-public sources, including but not limited to:

- Anthropic's `claude-code` proprietary source (any leaked or scraped copy)
- OpenAI internal code
- Any project with a license that prohibits reproduction

If your contribution is derived from a public source, link to it in the PR
description. If you're unsure, ask first.

## Pull request checklist

- [ ] Tests cover the new behavior.
- [ ] `bun run typecheck && bun run lint && bun run test` is green.
- [ ] No code copied from non-public sources.
- [ ] Commit messages follow conventional commit format.
- [ ] No new dependencies added without a one-line justification in the PR.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and
`./bin/asterisk status` + the relevant lines from `~/.asterisk/logs/daemon.log`.
