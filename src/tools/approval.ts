// The approval channel — carries a permission request from the Bash tool to
// whatever UI is attached, and the answer back.
//
// Same shape as ask.ts: subscribers on one side, a pending map keyed by request
// id on the other. The differences are all about failing closed.
//
//   * No subscriber means no human. A request with nobody able to answer it
//     resolves from the configured headless default instead of hanging until
//     the tool deadline.
//   * Subscribers are *per session*. The daemon serves many chats at once, and
//     a request raised by one chat's turn must be shown to that chat and no
//     other — so a subscriber declares which session ids it can answer for, and
//     "is anyone there" is asked about the session that is actually running,
//     never about the process as a whole.
//   * The timeout denies rather than allowing, and has to stay under the agent
//     loop's deadline for the calling tool — past that the loop kills the tool
//     and the user's answer lands nowhere. Bash is `interactive`, so that
//     deadline is loop.ts INTERACTIVE_TOOL_TIMEOUT_MS (15 minutes), not the
//     120s default.
//   * An aborted turn denies.

import { currentSessionId } from '../agent/context.ts';

export type ApprovalOutcome = 'allow-once' | 'allow-always' | 'deny';

export interface ApprovalRequest {
  id: string;
  /** Which session raised it — the chat id for bot turns, `repl` locally. */
  sessionId: string;
  /** The command as the model asked for it. */
  command: string;
  /** Why the policy could not decide on its own, in plain language. */
  reason: string;
  /** Rules that "always allow" would remember, shown so the scope is visible. */
  rules: readonly string[];
}

export interface ApprovalSubscription {
  /** Which sessions this UI can put a prompt in front of. Default: all. */
  accepts?: (sessionId: string) => boolean;
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

interface Subscriber {
  handler: (req: ApprovalRequest) => void;
  accepts: (sessionId: string) => boolean;
}

const subscribers = new Set<Subscriber>();
const pending = new Map<string, (result: ApprovalResult) => void>();

// Per-session count of requests that resolved to an automatic denial —
// nobody could be asked, or nobody answered in time. Kept separate from the
// ordinary refusal path (a person saying no) because a caller like
// `asterisk run` (src/run/cli.ts) needs to tell "refused by policy, and the
// model can work around that" apart from "refused only because this run had
// nobody to ask", and the tool_result text the model sees is not a contract
// any other module should be parsing to recover that distinction.
const autoDenials = new Map<string, number>();

/** How many approval requests in `sessionId` resolved automatically-denied
 *  since the counter was last cleared for it. */
export function automaticDenialCount(sessionId: string): number {
  return autoDenials.get(sessionId) ?? 0;
}

/** Drops the counter for one session. Callers that read it once per run
 *  should clear it afterwards so a long-lived process (the daemon) never
 *  accumulates counts for session ids it will never look at again. */
export function clearAutomaticDenials(sessionId: string): void {
  autoDenials.delete(sessionId);
}

function recordIfAutomaticDenial(sessionId: string, result: ApprovalResult): ApprovalResult {
  if (result.automatic && result.outcome === 'deny') {
    autoDenials.set(sessionId, (autoDenials.get(sessionId) ?? 0) + 1);
  }
  return result;
}

/** Subscribe a UI. Returns an unsubscribe function. */
export function onApprovalRequest(
  handler: (req: ApprovalRequest) => void,
  sub: ApprovalSubscription = {},
): () => void {
  const entry: Subscriber = { handler, accepts: sub.accepts ?? (() => true) };
  subscribers.add(entry);
  return () => {
    subscribers.delete(entry);
  };
}

/** Answer a pending request. No-op if it already resolved. */
export function resolveApproval(id: string, outcome: ApprovalOutcome): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve({ outcome });
  }
}

/**
 * True when some UI can show a prompt *for this session*. Exported for the
 * tool's messaging — the refusal text differs depending on whether a person
 * said no or nobody was asked.
 */
export function hasApprover(sessionId: string = currentSessionId()): boolean {
  for (const sub of subscribers) {
    if (sub.accepts(sessionId)) return true;
  }
  return false;
}

/**
 * Asks for approval and waits. Never rejects — every failure path resolves to
 * an outcome, because a thrown error here would surface as a tool crash rather
 * than a refusal.
 */
export async function requestApproval(
  req: Omit<ApprovalRequest, 'id' | 'sessionId'>,
  opts: ApprovalOptions,
): Promise<ApprovalResult> {
  const sessionId = currentSessionId();
  if (!hasApprover(sessionId)) {
    return recordIfAutomaticDenial(sessionId, {
      outcome: opts.headless === 'allow' ? 'allow-once' : 'deny',
      automatic: true,
    });
  }

  if (opts.signal?.aborted) {
    return recordIfAutomaticDenial(sessionId, { outcome: 'deny', automatic: true });
  }

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

  const full: ApprovalRequest = { id, sessionId, ...req };
  for (const sub of subscribers) {
    if (!sub.accepts(sessionId)) continue;
    try {
      sub.handler(full);
    } catch {
      // A UI that throws while rendering must not surface as a tool crash;
      // the request simply goes unanswered and the timeout denies it.
    }
  }

  try {
    const result = await Promise.race(
      aborted ? [answered, timedOut, aborted] : [answered, timedOut],
    );
    return recordIfAutomaticDenial(sessionId, result);
  } finally {
    if (timer) clearTimeout(timer);
    pending.delete(id);
  }
}

/** Test-only: drop any request left pending by a failed assertion, and any
 *  automatic-denial counters a test run left behind. */
export function _resetApprovalsForTesting(): void {
  pending.clear();
  subscribers.clear();
  autoDenials.clear();
}
