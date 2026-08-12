// The approval channel — carries a permission request from the Bash tool to
// whatever UI is attached, and the answer back.
//
// Same shape as ask.ts: an emitter the REPL subscribes to, a pending map keyed
// by request id. The differences are all about failing closed.
//
//   * No listener means no human. The daemon and the bot bridges run with
//     nobody at a terminal, so a request there resolves from the configured
//     headless default instead of hanging until the tool deadline.
//   * The timeout denies rather than allowing, and has to stay comfortably
//     under the agent loop's 120s tool deadline (loop.ts DEFAULT_TOOL_TIMEOUT_MS)
//     — past that the loop kills the tool and the user's answer lands nowhere.
//   * An aborted turn denies.

import { EventEmitter } from 'node:events';

export type ApprovalOutcome = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalRequest {
  id: string;
  /** The command as the model asked for it. */
  command: string;
  /** Why the policy could not decide on its own, in plain language. */
  reason: string;
  /** Rules that "always allow" would remember, shown so the scope is visible. */
  rules: readonly string[];
}

export interface ApprovalOptions {
  timeoutMs: number;
  /** What to answer when no UI is listening. */
  headless: 'deny' | 'allow';
  signal?: AbortSignal;
}

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  /** Set when the answer came from the headless default rather than a person. */
  automatic?: boolean;
}

const emitter = new EventEmitter();
const pending = new Map<string, (result: ApprovalResult) => void>();

/** Subscribe a UI. Returns an unsubscribe function. */
export function onApprovalRequest(handler: (req: ApprovalRequest) => void): () => void {
  emitter.on('approval', handler);
  return () => emitter.off('approval', handler);
}

/** Answer a pending request. No-op if it already resolved. */
export function resolveApproval(id: string, outcome: ApprovalOutcome): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve({ outcome });
  }
}

/** True when some UI can show a prompt. Exported for the tool's messaging. */
export function hasApprover(): boolean {
  return emitter.listenerCount('approval') > 0;
}

/**
 * Asks for approval and waits. Never rejects — every failure path resolves to
 * an outcome, because a thrown error here would surface as a tool crash rather
 * than a refusal.
 */
export async function requestApproval(
  req: Omit<ApprovalRequest, 'id'>,
  opts: ApprovalOptions,
): Promise<ApprovalResult> {
  if (!hasApprover()) {
    return { outcome: opts.headless === 'allow' ? 'allow-once' : 'deny', automatic: true };
  }

  if (opts.signal?.aborted) return { outcome: 'deny', automatic: true };

  const id = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const answered = new Promise<ApprovalResult>((resolve) => {
    pending.set(id, resolve);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ApprovalResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'deny', automatic: true }), opts.timeoutMs);
  });

  const aborted = opts.signal
    ? new Promise<ApprovalResult>((resolve) => {
        opts.signal?.addEventListener(
          'abort',
          () => resolve({ outcome: 'deny', automatic: true }),
          {
            once: true,
          },
        );
      })
    : null;

  emitter.emit('approval', { id, ...req } satisfies ApprovalRequest);

  try {
    return await Promise.race(aborted ? [answered, timedOut, aborted] : [answered, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    pending.delete(id);
  }
}

/** Test-only: drop any request left pending by a failed assertion. */
export function _resetApprovalsForTesting(): void {
  pending.clear();
  emitter.removeAllListeners('approval');
}
