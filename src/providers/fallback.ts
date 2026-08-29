// A provider that steps down a chain when the one in front of it is unusable.
//
// The motivating case is local-first: a laptop configured for a local model
// server that is not currently running. Every turn fails on a connection refused, and the
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
import { providerAcceptsImages } from './vision.ts';

/**
 * Failures that mean the backend is unavailable rather than the request being
 * wrong. `auth` is included: a missing or rejected key makes that provider
 * permanently unusable for this run, which is exactly when the next one should
 * get a turn.
 */
const FAILOVER_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'network',
  // The backend took the request and never answered. It is the reason a
  // local-first chain exists, and unlike the others here it is NOT retryable
  // (errors.ts): asking the same silent server again just spends another
  // timeout, so the chain is the only thing that can rescue the turn.
  'unresponsive',
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
 * The smallest window in the chain, not the first link's.
 *
 * History is built once and then sent to whichever link answers, so budgeting
 * against a 200k-token provider and landing on a 32k one overflows on
 * failover — precisely when things are already going badly. A link that does
 * not report a window makes the whole chain unknown: a minimum over the rest
 * would be a guess, and compaction's own default is the honest answer.
 *
 * Computed per call rather than once at construction. `openai-compatible`
 * exposes its window as a getter because it learns the server's real `n_ctx`
 * during the first `send()`; a value snapshotted while building the chain is
 * `undefined` forever, which is exactly the 128k-guess overflow that
 * model-detect.ts was written to end.
 */
function smallestWindow(links: readonly FallbackLink[]): number | undefined {
  let smallest: number | undefined;
  for (const link of links) {
    const window = link.provider.contextWindow;
    if (typeof window !== 'number' || window <= 0) return undefined;
    smallest = smallest === undefined ? window : Math.min(smallest, window);
  }
  return smallest;
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

  return {
    // Both of these are getters, not snapshots, because a link's own name and
    // window can be. `openai-compatible` reports the model the server says it
    // is serving, and it only learns that on the first request: read once at
    // construction, the chain said `openai-compatible:auto` for the rest of
    // the run and reported no window at all.
    get name(): string {
      return links.map((l) => l.provider.name).join(' → ');
    },
    get contextWindow(): number | undefined {
      return smallestWindow(links);
    },

    /**
     * Every link, not the first one — the same reasoning as `smallestWindow`.
     *
     * The message carrying the image is built once and then offered to
     * whichever link ends up answering, so a chain that says yes because its
     * head is multimodal turns a failover into a rejected request. A link that
     * never declared the capability counts as a no.
     */
    async supportsImages(): Promise<boolean> {
      const answers = await Promise.all(links.map((l) => providerAcceptsImages(l.provider)));
      return answers.every(Boolean);
    },

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
