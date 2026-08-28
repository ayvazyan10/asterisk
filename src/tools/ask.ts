// AskUserQuestion — pause the agent loop and ask the user a question. The
// REPL subscribes to the ask-events emitter and renders an interactive
// prompt; the user's answer resolves the tool's return promise.
//
// In the daemon (no human at the terminal) the tool times out after 5
// minutes and returns "(no answer)" so it doesn't deadlock.

import { EventEmitter } from 'node:events';

import { type Tool, err, ok } from './types.ts';

export interface AskQuestion {
  id: string;
  question: string;
  options?: string[];
  multiSelect: boolean;
  defaultValue?: string;
}

export interface AskAnswer {
  id: string;
  answer: string;
  cancelled?: boolean;
}

const ASK_TIMEOUT_MS = 5 * 60_000;

const emitter = new EventEmitter();
const pending = new Map<string, (answer: AskAnswer) => void>();

export function onAskQuestion(handler: (q: AskQuestion) => void): () => void {
  emitter.on('question', handler);
  return () => emitter.off('question', handler);
}

export function answerAskQuestion(id: string, answer: string): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve({ id, answer });
  }
}

export function cancelAskQuestion(id: string): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    resolve({ id, answer: '', cancelled: true });
  }
}

/** A timer that resolves to a cancellation once ASK_TIMEOUT_MS elapses, plus
 *  the means to cancel it — mirrors bots/telegram/approval.ts's prompt(). */
function makeTimeoutRace(id: string): { promise: Promise<AskAnswer>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<AskAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ id, answer: '', cancelled: true }), ASK_TIMEOUT_MS);
  });
  return {
    promise,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Same shape as makeTimeoutRace, but resolving on abort instead — null when
 *  there is no signal to listen to. */
function makeAbortRace(
  id: string,
  signal: AbortSignal | undefined,
): { promise: Promise<AskAnswer> | null; clear: () => void } {
  if (!signal) return { promise: null, clear: () => {} };
  let handler: (() => void) | undefined;
  const promise = new Promise<AskAnswer>((resolve) => {
    handler = () => resolve({ id, answer: '', cancelled: true });
    signal.addEventListener('abort', handler, { once: true });
  });
  return {
    promise,
    clear: () => {
      if (handler) signal.removeEventListener('abort', handler);
    },
  };
}

export const askUserQuestionTool: Tool = {
  name: 'AskUserQuestion',
  interactive: true,
  description:
    'Pause and ask the user a question. Returns the user\'s answer (or "(cancelled)" if they Esc). Use when you need an authoritative decision the user has to make: pick between options, confirm a destructive action, supply missing info. Times out after 5 minutes.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question shown to the user.' },
      options: {
        type: 'array',
        description: 'Optional choices. If provided, the REPL renders a list picker.',
        items: { type: 'string' },
      },
      multiSelect: {
        type: 'boolean',
        description: 'Allow multiple selections (default false).',
      },
      defaultValue: { type: 'string', description: 'Default answer for free-text questions.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const question = typeof input['question'] === 'string' ? input['question'].trim() : '';
    if (!question) return err('question is required');
    const optionsRaw = input['options'];
    const options: string[] | undefined = Array.isArray(optionsRaw)
      ? optionsRaw.filter((x): x is string => typeof x === 'string')
      : undefined;
    const multiSelect = input['multiSelect'] === true;
    const defaultValue =
      typeof input['defaultValue'] === 'string' ? input['defaultValue'] : undefined;

    if (emitter.listenerCount('question') === 0) {
      return err(
        'AskUserQuestion called but no UI is listening (running headless? in daemon-only mode?)',
      );
    }

    const id = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const answerPromise = new Promise<AskAnswer>((resolve) => {
      pending.set(id, resolve);
    });
    const timeout = makeTimeoutRace(id);
    const abort = makeAbortRace(id, opts?.signal);

    const q: AskQuestion = {
      id,
      question,
      multiSelect,
      ...(options !== undefined ? { options } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
    emitter.emit('question', q);

    const candidates = abort.promise
      ? [answerPromise, timeout.promise, abort.promise]
      : [answerPromise, timeout.promise];
    const result = await Promise.race(candidates);
    pending.delete(id);
    // Whichever race arm won, the other(s) are now moot — clear the timer and
    // drop the abort listener rather than leaving them live until they fire
    // on their own. See bots/telegram/approval.ts's prompt() for the same
    // pattern.
    timeout.clear();
    abort.clear();

    if (result.cancelled) return ok('(cancelled)');
    return ok(result.answer);
  },
};

export const ASK_TOOLS: Tool[] = [askUserQuestionTool];
