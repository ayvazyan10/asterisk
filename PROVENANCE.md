# Provenance

This document exists so that anyone evaluating Asterisk — a user, a
contributor, or someone's legal team — can see exactly where the code came
from without having to take a maintainer's word for it.

## Summary

Asterisk is an independent, clean-room implementation. Every line in this
repository was written from public sources: published documentation, public
npm packages and their type definitions, protocol specifications, and the
observable behaviour of the APIs it talks to.

It is licensed under Apache 2.0 (see [LICENSE](LICENSE)).

## What "clean room" means here, concretely

Asterisk is an agent CLI, and agent CLIs share an obvious architectural shape:
a loop that calls a model, executes the tools the model asks for, feeds the
results back, and stops on a terminal condition. That shape is described in
public vendor documentation and implemented by many projects. Asterisk follows
it.

Following a documented architecture is not the same as copying an
implementation, and the distinction is the one this project holds itself to:

- **Architectural patterns are fair game.** A tool-use loop, a provider
  abstraction, a slash-command registry, a hook lifecycle — these are ideas,
  described publicly, and independently implementable.
- **Specific expression is not.** No file, function body, comment, string
  table, prompt, or test was copied from a non-public source.

## Sources actually used

- **Anthropic Messages API documentation** — request/response shapes, tool
  use, prompt caching, streaming semantics, error taxonomy.
  <https://docs.anthropic.com/en/api/messages>
- **`@anthropic-ai/sdk`** — the public npm package, used as a dependency and
  as a type reference. <https://github.com/anthropics/anthropic-sdk-typescript>
- **Model Context Protocol specification** and the public
  `@modelcontextprotocol/sdk`. <https://modelcontextprotocol.io/specification>
- **Ollama API documentation** — the native `/api/chat` surface, `num_ctx`,
  `think`, NDJSON streaming. <https://github.com/ollama/ollama/blob/main/docs/api.md>
- **OpenAI Chat Completions API documentation** — for the
  `openai-compatible` provider, which targets llama.cpp's `llama-server`,
  LM Studio, vLLM and similar servers.
- **Public documentation for the runtime dependencies** — Bun, Ink, React,
  grammy, Playwright, Zod, pino, undici, SQLite.

Where a non-obvious behaviour is implemented because a specification or a
vendor document says so, the source is cited in a comment at the call site.

## The disclosure

A copy of Anthropic's `claude-code` source, obtained from a public leak, has
existed on the original author's machine and was consulted **as an
architectural reference only** during early design — to understand *what* a
mature agent CLI does, not *how* it writes it.

This is stated plainly rather than omitted, because a reader who discovered it
later would be right to distrust everything else in this file.

The rules that follow from it, which the project applies to itself and to
contributors:

1. No file is copied from that tree, in whole or in part.
2. No function body, comment, prompt text, or test is pasted from it.
3. Anything that would otherwise be taken from it is instead derived from a
   public source, and that source is cited.
4. Contributors must not consult it at all. See
   [CONTRIBUTING.md](CONTRIBUTING.md#provenance--non-negotiable).

Asterisk is written in TypeScript on Bun with an Ink/React terminal UI, a
SQLite configuration store, a Zod-derived web control panel, and a Telegram
bot transport. Its module layout, data model,
configuration system, command surface, and tests are its own.

## If you believe something here is wrong

If you find code in this repository that you believe was copied from a source
it should not have been, please report it — privately if you prefer, per
[SECURITY.md](SECURITY.md). Concrete reports (a file and a line range, and
what you believe it was taken from) will be investigated, and anything that
cannot be defended as independently written will be rewritten or removed.

That commitment is the point of this document. A provenance claim is only
worth something if there is a way to challenge it.
