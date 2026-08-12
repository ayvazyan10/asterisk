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

export const askUserQuestionTool: Tool = {
  name: 'AskUserQuestion',
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
    const timeoutPromise = new Promise<AskAnswer>((resolve) =>
      setTimeout(() => resolve({ id, answer: '', cancelled: true }), ASK_TIMEOUT_MS),
    );
    const abortPromise = opts?.signal
      ? new Promise<AskAnswer>((resolve) => {
          opts.signal?.addEventListener(
            'abort',
            () => resolve({ id, answer: '', cancelled: true }),
            {
              once: true,
            },
          );
        })
      : null;

    const q: AskQuestion = {
      id,
      question,
      multiSelect,
      ...(options !== undefined ? { options } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
    };
    emitter.emit('question', q);

    const result = abortPromise
      ? await Promise.race([answerPromise, timeoutPromise, abortPromise])
      : await Promise.race([answerPromise, timeoutPromise]);
    pending.delete(id);

    if (result.cancelled) return ok('(cancelled)');
    return ok(result.answer);
  },
};

export const ASK_TOOLS: Tool[] = [askUserQuestionTool];
