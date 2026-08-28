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
//
// ASTERISK_LOCALE is the dedicated variable for this. It used to be
// ASTERISK_LANG, which was already spoken for: src/rules/loader.ts reads it
// to pin the *project* language (typescript, python, …) for the layered
// rules feature, and that usage predates this one. The two vocabularies
// don't overlap (en/ru vs. typescript/python/…), so nothing ever caught the
// collision — a Russian-speaking user setting ASTERISK_LANG=ru for the
// interface silently lost their whole per-language rules layer, with no
// error. ASTERISK_LANG is still read here, for one release, at lower
// precedence than ASTERISK_LOCALE and only when its value actually names a
// locale — see detectLocale.

import { type Locale, MESSAGES, type MessageKey, isLocale } from './messages.ts';

export type { Locale, MessageKey } from './messages.ts';
export { SUPPORTED_LOCALES } from './messages.ts';

/** Fallback for anything the active locale has not translated. */
const BASE_LOCALE: Locale = 'en';

let cached: Locale | null = null;

/**
 * Reads the locale out of the environment.
 *
 * `ASTERISK_LOCALE` wins so a user can override a system locale they cannot
 * change. `LC_ALL` then `LANG` follow POSIX precedence. Values arrive as
 * `ru_RU.UTF-8` or `C.UTF-8`, so only the leading language subtag is used —
 * and `C`/`POSIX` mean "no locale", which is English here rather than a
 * failed lookup.
 *
 * `ASTERISK_LANG` is honoured too, right below `ASTERISK_LOCALE` and above
 * `LC_ALL`/`LANG` — the same precedence it always had — but only when its
 * value actually names a locale asterisk ships. It is now dedicated to
 * pinning the *project* language for the rules layer
 * (src/rules/loader.ts), so a value like "typescript" must never leak into
 * the interface language here, the way "ru" must never leak into that
 * project-language pin. Reading it here at all is a one-release grace
 * period for scripts that still export it for this purpose; each use warns
 * once and names `ASTERISK_LOCALE` as the replacement.
 */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const primary = readLocaleTag(env['ASTERISK_LOCALE']);
  if (primary) return primary;

  const legacyRaw = env['ASTERISK_LANG']?.trim();
  if (legacyRaw) {
    const legacy = readLocaleTag(legacyRaw);
    if (legacy) {
      warnLegacyAsteriskLangForLocale(legacyRaw);
      return legacy;
    }
  }

  for (const key of ['LC_ALL', 'LANG'] as const) {
    const tag = readLocaleTag(env[key]);
    if (tag) return tag;
  }
  return BASE_LOCALE;
}

/** Parses one env value into a Locale, or null if it names neither a
 *  supported locale nor "no locale" (`C`/`POSIX`, blank/absent). */
function readLocaleTag(raw: string | undefined): Locale | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const tag = (trimmed.split(/[._@-]/)[0] ?? '').toLowerCase();
  if (tag === 'c' || tag === 'posix') return BASE_LOCALE;
  return isLocale(tag) ? tag : null;
}

let warnedLegacyLangForLocale = false;

function warnLegacyAsteriskLangForLocale(value: string): void {
  if (warnedLegacyLangForLocale) return;
  warnedLegacyLangForLocale = true;
  console.error(
    `asterisk: ASTERISK_LANG=${value} is being read as the interface locale for backward compatibility. ASTERISK_LANG now pins the project language for rules — set ASTERISK_LOCALE=${value} instead to silence this warning.`,
  );
}

/** The active locale, resolved once per process. */
export function locale(): Locale {
  cached ??= detectLocale();
  return cached;
}

/** Test-only: forget the resolved locale so a different env can be read. */
export function _resetLocaleForTesting(): void {
  cached = null;
  warnedLegacyLangForLocale = false;
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
