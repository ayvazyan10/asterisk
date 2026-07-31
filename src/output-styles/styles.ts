// Output styles — pluggable behaviour modifiers spliced into the system
// prompt alongside rules + soul. Toggled via /output-style or by setting
// outputStyle in ~/.asterisk/asterisk.db. Persists across turns.
//
// Provenance: idea inspired by claude-code-main's output-style system
// (default / Explanatory / Learning). Prose authored fresh.

export type OutputStyleName = 'default' | 'concise' | 'explanatory' | 'learning';

export interface OutputStyle {
  name: OutputStyleName;
  description: string;
  /** Markdown block spliced into the system prompt under "# Output style".
   *  Empty for 'default' (no extra instructions). */
  prompt: string;
}

const DEFAULT: OutputStyle = {
  name: 'default',
  description: 'Baseline — no extra style instructions.',
  prompt: '',
};

const CONCISE: OutputStyle = {
  name: 'concise',
  description: 'Trim every reply to the minimum useful answer.',
  prompt: `Trim ruthlessly. Direct answer first, no preamble, no restatement
of the question, no "Sure, here's …" framing. If a sentence can be deleted
without losing meaning, delete it. Lists over prose. Skip closing pleasantries.
If the answer is one word, return one word.`,
};

const EXPLANATORY: OutputStyle = {
  name: 'explanatory',
  description: 'Walk through reasoning + tradeoffs alongside the answer (good for learning a codebase).',
  prompt: `When you make a non-obvious decision — a refactor approach, a
library choice, a data-shape, an algorithmic call — show your reasoning in
one short paragraph alongside the answer. Format:

1. The action / answer.
2. Why this and not the alternatives (one line each for the runners-up).
3. What to watch for if the constraint shifts.

Keep it concrete. Don't lecture on the basics; assume the reader is a senior
engineer who wants the *judgement*, not the textbook. If the decision was
trivial, skip the explanation — empty calories defeat the purpose.`,
};

const LEARNING: OutputStyle = {
  name: 'learning',
  description: 'Collaborative — propose options, ask the user to pick or contribute, before applying.',
  prompt: `You're working with the user collaboratively, not for them. When
you reach a non-trivial design decision (data shape, error-handling pattern,
naming, architectural split), pause and use AskUserQuestion to surface the
options:

- Frame the decision in one sentence.
- Offer 2–3 candidates with one-line tradeoffs each.
- Mark your default pick but make it easy to override.
- Only proceed once the user has chosen (or said "you pick").

Skip the prompt for trivial calls (renaming a local variable, fixing an
obvious typo). Save the collaboration ritual for the decisions that
actually shape the codebase. The goal is to keep the user in the loop on
the choices that will matter to them later, not to ask permission every
time you touch a file.`,
};

export const OUTPUT_STYLES: OutputStyle[] = [DEFAULT, CONCISE, EXPLANATORY, LEARNING];

export function findOutputStyle(name: string): OutputStyle | undefined {
  const norm = name.trim().toLowerCase();
  return OUTPUT_STYLES.find((s) => s.name === norm);
}

export function outputStyleToPromptSection(style: OutputStyle | undefined): string {
  if (!style || !style.prompt) return '';
  return [`# Output style: ${style.name}`, style.prompt].join('\n');
}
