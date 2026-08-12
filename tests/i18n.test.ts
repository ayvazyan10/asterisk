// Interface language.
//
// The assertion that matters most is not about translation at all: it is that
// the catalogue holds only what the *user* reads. Tool names, tool
// descriptions, the system prompt and tool results go to the model, and
// translating those would change how the agent behaves rather than how it
// looks — a model tuned on English tool descriptions given Russian ones is a
// different, worse model.

import { describe, expect, it } from 'vitest';

import { _resetLocaleForTesting, detectLocale, locale, t } from '../src/i18n/index.ts';
import { MESSAGES, SUPPORTED_LOCALES, isLocale } from '../src/i18n/messages.ts';

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetLocaleForTesting();
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetLocaleForTesting();
  }
}

describe('detectLocale', () => {
  it.each([
    ['ru', 'ru'],
    ['ru_RU.UTF-8', 'ru'],
    ['ru_RU', 'ru'],
    ['en_GB.UTF-8', 'en'],
  ])('reads %s as %s', (value, expected) => {
    expect(detectLocale({ LANG: value })).toBe(expected);
  });

  it('treats C and POSIX as English rather than a failed lookup', () => {
    // These mean "no locale", which is not the same as an unknown one.
    expect(detectLocale({ LANG: 'C.UTF-8' })).toBe('en');
    expect(detectLocale({ LANG: 'POSIX' })).toBe('en');
  });

  it('falls back to English for a language we do not ship', () => {
    expect(detectLocale({ LANG: 'fr_FR.UTF-8' })).toBe('en');
  });

  it('prefers ASTERISK_LANG over the system locale', () => {
    // So a user who cannot change the system locale can still choose.
    expect(detectLocale({ ASTERISK_LANG: 'ru', LANG: 'en_US.UTF-8' })).toBe('ru');
  });

  it('follows POSIX precedence between LC_ALL and LANG', () => {
    expect(detectLocale({ LC_ALL: 'ru_RU.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ru');
  });

  it('ignores blank values instead of treating them as a choice', () => {
    expect(detectLocale({ ASTERISK_LANG: '  ', LANG: 'ru_RU.UTF-8' })).toBe('ru');
  });

  it('defaults to English with nothing set', () => {
    expect(detectLocale({})).toBe('en');
  });
});

describe('t', () => {
  it('returns the active locale', () => {
    withEnv({ ASTERISK_LANG: 'ru' }, () => {
      expect(locale()).toBe('ru');
      expect(t('approval.title')).toBe('Разрешить эту команду?');
    });
  });

  it('interpolates named placeholders', () => {
    withEnv({ ASTERISK_LANG: 'en' }, () => {
      expect(t('status.queued', { count: 3 })).toBe('3 queued');
    });
  });

  it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
    withEnv({ ASTERISK_LANG: 'en' }, () => {
      // A stray `{count}` on screen is a bug report; "undefined" is a mystery.
      expect(t('status.queued')).toContain('{count}');
    });
  });

  it('falls back to English for a key a translation is missing', () => {
    // Rendering the key itself would give the user strictly less than the
    // untranslated English would have.
    const ru = MESSAGES.ru as Record<string, string | undefined>;
    const saved = ru['approval.deny'];
    delete ru['approval.deny'];
    try {
      withEnv({ ASTERISK_LANG: 'ru' }, () => {
        expect(t('approval.deny')).toBe('Deny');
      });
    } finally {
      ru['approval.deny'] = saved;
    }
  });

  it('caches the locale so one process does not change language mid-session', () => {
    withEnv({ ASTERISK_LANG: 'ru' }, () => {
      expect(locale()).toBe('ru');
      process.env['ASTERISK_LANG'] = 'en';
      expect(locale()).toBe('ru');
    });
  });
});

describe('the catalogue', () => {
  it('has an English string for every key', () => {
    for (const [key, value] of Object.entries(MESSAGES.en)) {
      expect(value, key).toBeTruthy();
    }
  });

  it('never invents a key English does not have', () => {
    // TypeScript enforces this at compile time; asserting it here catches a
    // catalogue edited past the type, e.g. through a cast.
    const english = new Set(Object.keys(MESSAGES.en));
    for (const loc of SUPPORTED_LOCALES) {
      for (const key of Object.keys(MESSAGES[loc])) {
        expect(english.has(key), `${loc}: ${key}`).toBe(true);
      }
    }
  });

  it('keeps every placeholder a translation inherits', () => {
    // A translation that drops `{count}` silently loses the number.
    const placeholders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort();
    for (const loc of SUPPORTED_LOCALES) {
      for (const [key, translated] of Object.entries(MESSAGES[loc])) {
        const source = MESSAGES.en[key as keyof typeof MESSAGES.en];
        expect(placeholders(translated as string), `${loc}: ${key}`).toEqual(placeholders(source));
      }
    }
  });

  it('translates nothing the model reads', async () => {
    // The boundary this whole module rests on. Tool names are identifiers the
    // provider matches on; tool descriptions are behaviour. If one ever shows
    // up here, the failure is that the agent got quietly worse in Russian.
    const { listTools } = await import('../src/tools/registry.ts');
    const toolNames = new Set(listTools().map((tool) => tool.name));
    for (const value of Object.values(MESSAGES.en)) {
      expect(toolNames.has(value)).toBe(false);
    }
  });

  it('exposes only locales it can actually serve', () => {
    for (const loc of SUPPORTED_LOCALES) expect(isLocale(loc)).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
