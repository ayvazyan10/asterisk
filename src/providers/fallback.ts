// A provider that steps down a chain when the one in front of it is unusable.
//
// The motivating case is local-first: a laptop running Ollama that is not
// currently running Ollama. Every turn fails on a connection refused, and the
// configured Anthropic key sits unused because `provider` names exactly one
// backend. With a chain, the turn lands.
//
// Two things this deliberately does NOT do.
//
// It does not fail over on `bad-request` or `context-overflow`. Those describe
// the request, not the backend — retrying them elsewhere would burn a second
// provider on the same malformed input and, worse, hide the bug behind a model
// switch. Only failures that mean "this backend cannot serve me right now"
// advance the chain.
//
// It does not fail over once the reply has started streaming. Text already on
// the user's screen cannot be unsent, so a second attempt would append a
// second answer to the first one's opening paragraph.

import type { Provider, ProviderRequest, ProviderResponse } from '../types/messages.ts';
import { ProviderError, type ProviderErrorKind } from './errors.ts';

/**
 * Failures that mean the backend is unavailable rather than the request being
 * wrong. `auth` is included: a missing or rejected key makes that provider
 * permanently unusable for this run, which is exactly when the next one should
 * get a turn.
 */
const FAILOVER_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'network',
  'server',
  'overloaded',
  'rate-limit',
  'auth',
]);

export interface FallbackLink {
  provider: Provider;
  /** Shown when this link is the one that answers after a failure. */
  label: string;
}

export interface FallbackOptions {
  /** Fired when a link fails and the next is tried. */
  onFailover?(from: string, to: string, reason: string): void;
}

function shouldFailover(error: unknown): boolean {
  return error instanceof ProviderError && FAILOVER_KINDS.has(error.kind);
}

/**
 * Wraps a chain of providers so a request walks down it until one answers.
 *
 * A single link is returned unwrapped: there is nothing to fall back to, and
 * wrapping would only add a stack frame to every error.
 */
export function createFallbackProvider(
  links: readonly FallbackLink[],
  opts: FallbackOptions = {},
): Provider {
  const first = links[0];
  if (!first) throw new Error('a fallback chain needs at least one provider');
  if (links.length === 1) return first.provider;

  // The smallest window in the chain, not the first link's. History is built
  // once and then sent to whichever link answers, so budgeting against a
  // 200k-token provider and landing on a 32k one overflows on failover —
  // precisely when things are already going badly.
  const windows = links
    .map((l) => l.provider.contextWindow)
    .filter((w): w is number => typeof w === 'number' && w > 0);
  const contextWindow = windows.length === links.length ? Math.min(...windows) : undefined;

  return {
    name: links.map((l) => l.label).join(' → '),
    ...(contextWindow !== undefined ? { contextWindow } : {}),

    async send(req: ProviderRequest): Promise<ProviderResponse> {
      let lastError: unknown;

      for (let i = 0; i < links.length; i++) {
        const link = links[i] as FallbackLink;

        // Once a link has emitted text, its partial answer is on screen and the
        // chain has to stop here — the alternative is two half-answers spliced
        // together.
        let emitted = false;
        const guarded: ProviderRequest = req.onText
          ? {
              ...req,
              onText: (delta) => {
                emitted = true;
                req.onText?.(delta);
              },
            }
          : req;

        try {
          return await link.provider.send(guarded);
        } catch (e) {
          lastError = e;
          const next = links[i + 1];
          if (!next || emitted || !shouldFailover(e)) throw e;
          opts.onFailover?.(link.label, next.label, (e as Error).message);
        }
      }

      throw lastError;
    },
  };
}
