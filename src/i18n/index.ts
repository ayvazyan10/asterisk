// Interface language.
//
// The line that matters most here is which strings are in scope. Asterisk has
// two audiences and they must not be conflated:
//
//   * the user reads the REPL chrome, prompts, menus and errors — that is what
//     this translates;
//   * the model reads the system prompt, tool names, tool descriptions and
//     tool results — that is NOT translated, and translating it would be a
//     bug, not a feature. Those strings are load-bearing behaviour: models are
//     tuned on English tool descriptions, `Bash` is an identifier the provider
//     matches on, and a tool result the model has to parse should read the
//     same in every locale. Localising them would change how the agent behaves
//     rather than how it looks.
//
// Locale comes from the environment rather than configuration on purpose: it
// is a property of the terminal you are sitting at, not of the install, and a
// user with two terminals in two languages should not have to reconfigure the
// agent between them.

import { type Locale, MESSAGES, type MessageKey, isLocale } from './messages.ts';

export type { Locale, MessageKey } from './messages.ts';
export { SUPPORTED_LOCALES } from './messages.ts';

/** Fallback for anything the active locale has not translated. */
const BASE_LOCALE: Locale = 'en';

let cached: Locale | null = null;

/**
 * Reads the locale out of the environment.
 *
 * `ASTERISK_LANG` wins so a user can override a system locale they cannot
 * change. `LC_ALL` then `LANG` follow POSIX precedence. Values arrive as
 * `ru_RU.UTF-8` or `C.UTF-8`, so only the leading language subtag is used —
 * and `C`/`POSIX` mean "no locale", which is English here rather than a
 * failed lookup.
 */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  for (const key of ['ASTERISK_LANG', 'LC_ALL', 'LANG'] as const) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const tag = (raw.split(/[._@-]/)[0] ?? '').toLowerCase();
    if (tag === 'c' || tag === 'posix') return BASE_LOCALE;
    if (isLocale(tag)) return tag;
  }
  return BASE_LOCALE;
}

/** The active locale, resolved once per process. */
export function locale(): Locale {
  cached ??= detectLocale();
  return cached;
}

/** Test-only: forget the resolved locale so a different env can be read. */
export function _resetLocaleForTesting(): void {
  cached = null;
}

/**
 * Looks up a message, interpolating `{name}` placeholders.
 *
 * A key missing from the active locale falls back to English rather than
 * rendering the key itself: a user who sees `repl.status.provider` on screen
 * has been given strictly less than the untranslated English would have told
 * them. `MessageKey` is a union over the English catalogue, so a typo is a
 * compile error and this fallback only ever covers a genuine gap in a
 * translation.
 */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const active = MESSAGES[locale()] as Partial<Record<MessageKey, string>>;
  // `MESSAGES.en` rather than `MESSAGES[BASE_LOCALE]`: indexing by a variable
  // of type Locale resolves to the Partial half of the intersection, which
  // loses the guarantee that English is complete.
  const template = active[key] ?? MESSAGES.en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
