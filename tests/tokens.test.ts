// The token estimate drives the compaction budget, so its failure mode is a
// context-overflow error from the provider rather than a wrong number on a
// screen. These tests pin the properties that matter — chiefly that nothing is
// under-counted by a multiple — rather than exact counts, which would only
// pin the constants to themselves.

import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../src/agent/compaction.ts';
import { estimateTextTokens } from '../src/agent/tokens.ts';
import type { Message } from '../src/types/messages.ts';

/** What the previous implementation would have said. */
function charsOverFour(text: string): number {
  return Math.ceil(text.length / 4);
}

const CHINESE = '你好世界，这是一个测试。我们正在检查分词器的准确性。';
const JAPANESE = 'こんにちは世界、これはトークナイザーのテストです。';
const KOREAN = '안녕하세요 세계, 이것은 토크나이저 테스트입니다.';
const TYPESCRIPT =
  'export function compactHistory(messages: Message[], contextWindow?: number): Message[] {';
const JSON_BODY = '{"model":"gemma-4-26b","stream":true,"options":{"num_ctx":65536}}';

// Non-Latin reference samples, with the token count llama.cpp's /tokenize
// actually returned for each over the multilingual Qwen3 vocabulary (n_vocab
// 248320) — the same measurement src/agent/tokens.ts is calibrated against.
// Pinned as constants on purpose: these tests must not need a model server.
//
// Paragraph scale rather than one sentence, because that is the scale the
// compaction budget sums over, and a character-class model lands either side
// of the true count on any single short string.
const RUSSIAN_PROSE =
  'Привет! Оценщик токенов занижал стоимость кириллицы, поэтому компакция не срабатывала вовремя и контекстное окно переполнялось. ' +
  'Давай измерим реальное количество токенов на настоящем токенизаторе, а не будем гадать по эмпирическим правилам из блогов. ' +
  'Занижение опаснее завышения: программа думает, что всё помещается, а сервер отвечает ошибкой переполнения контекста.';
const RUSSIAN_PROSE_REAL = 103;

const ARMENIAN_PROSE =
  'Բարև ձեզ։ Ծրագիրը սխալ էր հաշվում հայերեն տեքստի չափը, որովհետև բառարանում այդ տառերը գրեթե չկան։ ' +
  'Յուրաքանչյուր տառ բաժանվում է առանձին բայթերի, և մեկ տառը արժենում է մեկից ավելի նշան։ ' +
  'Ավելի լավ է մի փոքր ավելի շատ հաշվել, քան պակաս, որովհետև պակաս հաշվելը վտանգավոր է։';
const ARMENIAN_PROSE_REAL = 193;

const UKRAINIAN_PROSE =
  'Привіт! Оцінювач токенів занижував вартість кирилиці, тому історія розмови переповнювала контекстне вікно. ' +
  'Рішення просте: треба виміряти реальну кількість токенів на справжньому токенізаторі й підібрати коефіцієнт окремо. ' +
  'Головне не перестаратися, бо завищення призводить до втрати історії розмови раніше часу.';
const UKRAINIAN_PROSE_REAL = 110;

const HEBREW_PROSE =
  'שלום. התוכנית חישבה לא נכון את גודל הטקסט העברי, מפני שאין את האותיות האלה במילון של המודל. ' +
  'הפתרון הוא למדוד את הערך האמיתי במקום לנחש אותו, ואז החישוב יהיה מדויק והשיחה לא תיקטע.';
const HEBREW_PROSE_REAL = 80;

const GEORGIAN_PROSE =
  'გამარჯობა. პროგრამა არასწორად ითვლიდა ქართული ტექსტის ზომას, რადგან ლექსიკონში ეს ასოები არ არის. ' +
  'გამოსავალი არის რეალური მნიშვნელობის გაზომვა და არა გამოცნობა, რათა საუბარი ნაადრევად არ შეწყდეს.';
const GEORGIAN_PROSE_REAL = 103;

const MIXED_RU_EN =
  'Поправил estimateTextTokens в src/agent/tokens.ts — теперь armenian и georgian считаются отдельным классом. ' +
  'Прогнал calibration script: est/real по всем классам в диапазоне от 1.02 до 1.28, вместо 0.46 на армянском. ' +
  'Проверил bun run typecheck, bun run lint и bun run test — всё зелёное, ничего не сломалось.';
const MIXED_RU_EN_REAL = 94;

/** What the pre-calibration model charged every non-Latin, non-CJK character. */
const OLD_SINGLE_CLASS_COST = 1 / 3;

describe('estimateTextTokens', () => {
  it('is zero for empty input', () => {
    expect(estimateTextTokens('')).toBe(0);
  });

  it('grows with length', () => {
    expect(estimateTextTokens('word word')).toBeGreaterThan(estimateTextTokens('word'));
  });

  it('keeps English prose in a sane band', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running.';
    const tokens = estimateTextTokens(text);
    // 62 characters, ~13 real tokens. Anything outside this band means the
    // model drifted badly for the most common input there is.
    expect(tokens).toBeGreaterThan(text.length / 8);
    expect(tokens).toBeLessThan(text.length / 2);
  });

  it.each([
    ['chinese', CHINESE],
    ['japanese', JAPANESE],
    ['korean', KOREAN],
  ])('counts %s at roughly one token per character', (_name, text) => {
    const tokens = estimateTextTokens(text);
    // The old estimate said a quarter of this and let CJK conversations
    // overflow the window with compaction never firing.
    expect(tokens).toBeGreaterThan(text.length * 0.8);
    expect(tokens).toBeGreaterThan(charsOverFour(text) * 3);
  });

  it.each([
    ['typescript', TYPESCRIPT],
    ['json', JSON_BODY],
  ])('counts punctuation-dense %s above the prose rate', (_name, text) => {
    expect(estimateTextTokens(text)).toBeGreaterThan(charsOverFour(text));
  });

  it('counts an emoji as more than one token', () => {
    // Astral code points are two UTF-16 units; counting by unit would have
    // said one token for two halves of one character.
    expect(estimateTextTokens('🚀')).toBeGreaterThanOrEqual(2);
  });

  it('treats a long identifier as several tokens but a short word as one', () => {
    expect(estimateTextTokens('cat')).toBe(1);
    expect(estimateTextTokens('internationalization')).toBeGreaterThan(3);
  });

  it('never under-counts any sample by a multiple', () => {
    // The whole point of the change: the old model was 0.27x on Chinese.
    for (const text of [CHINESE, JAPANESE, KOREAN, TYPESCRIPT, JSON_BODY, 'ship it 🚀🔥']) {
      expect(estimateTextTokens(text)).toBeGreaterThanOrEqual(charsOverFour(text) * 0.9);
    }
  });
});

describe('estimateTextTokens against measured Qwen3 counts', () => {
  // Every ratio below is estimate / real-tokens-from-llama.cpp. The band is
  // asymmetric on purpose: under-counting overflows the provider's window,
  // over-counting only compacts sooner than it had to.
  it.each([
    ['russian', RUSSIAN_PROSE, RUSSIAN_PROSE_REAL],
    ['ukrainian', UKRAINIAN_PROSE, UKRAINIAN_PROSE_REAL],
    ['hebrew', HEBREW_PROSE, HEBREW_PROSE_REAL],
    ['georgian', GEORGIAN_PROSE, GEORGIAN_PROSE_REAL],
    ['armenian', ARMENIAN_PROSE, ARMENIAN_PROSE_REAL],
    ['mixed russian/english', MIXED_RU_EN, MIXED_RU_EN_REAL],
  ])('keeps %s within the calibrated band of its real token count', (_name, text, real) => {
    const tokens = estimateTextTokens(text);
    // 0.95 rather than 1.0: a per-character model cannot track an individual
    // paragraph exactly, and Armenian sits at 0.99 on this one. What the band
    // rules out is the failure that was actually happening — see below.
    expect(tokens).toBeGreaterThanOrEqual(real * 0.95);
    expect(tokens).toBeLessThanOrEqual(real * 1.4);
  });

  it('no longer reports Armenian at half its real size', () => {
    // The regression this file exists to fix. One `else` branch charged 1/3 of
    // a token for every non-Latin character, but Armenian has no vocabulary
    // coverage at all and falls back to raw UTF-8 bytes at ~1.4 characters per
    // token. The estimate came out at 0.46 of the truth, so an Armenian
    // conversation overflowed the window with compaction never having fired.
    const tokens = estimateTextTokens(ARMENIAN_PROSE);
    const old = ARMENIAN_PROSE.length * OLD_SINGLE_CLASS_COST;
    expect(old / ARMENIAN_PROSE_REAL).toBeLessThan(0.5);
    expect(tokens).toBeGreaterThan(old * 2);
  });

  it('charges extended Cyrillic more than the Russian alphabet', () => {
    // U+0410-044F is covered well (3.6 chars/token); the letters Kazakh and
    // friends need at U+0460-052F fall back to bytes (1.4). Same block, same
    // character count, and the old model could not tell them apart.
    const russianLetters = 'абвгдежзийклмноп';
    const extendedLetters = 'әғқңөұүһәғқңөұүһ';
    expect(extendedLetters).toHaveLength(russianLetters.length);
    expect(estimateTextTokens(extendedLetters)).toBeGreaterThan(
      estimateTextTokens(russianLetters) * 2,
    );
  });

  it('leaves the ASCII path exactly where it was', () => {
    // The calibration changed non-Latin script costs only. Pinned to the value
    // the pre-change implementation produced, so a future edit to the ASCII
    // rules has to be a deliberate one. Code still reads ~0.87 of its real
    // cost — a separate problem, since real punctuation cost swings from 0.35
    // tokens/char in JSON to 0.91 in prose.
    expect(
      estimateTextTokens('The quick brown fox jumps over the lazy dog and keeps running.'),
    ).toBe(16.25);
    expect(estimateTextTokens(TYPESCRIPT)).toBe(25.75);
    expect(estimateTextTokens(JSON_BODY)).toBe(22);
  });

  it('still counts CJK at about one token per character', () => {
    // Unchanged by the calibration: the script ranges are all below U+1100 and
    // are tested before the CJK pattern, so no code point can match both.
    for (const text of [CHINESE, JAPANESE, KOREAN]) {
      expect(estimateTextTokens(text)).toBeGreaterThan(text.length * 0.8);
      expect(estimateTextTokens(text)).toBeLessThanOrEqual(text.length);
    }
  });

  it('is zero for the empty string after the split', () => {
    expect(estimateTextTokens('')).toBe(0);
  });
});

describe('estimateTokens over messages', () => {
  const msg = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });

  it('charges per-message framing so many small messages are not free', () => {
    const one = estimateTokens([msg('hello world hello world')]);
    const many = estimateTokens([msg('hello'), msg('world'), msg('hello'), msg('world')]);
    expect(many).toBeGreaterThan(one);
  });

  it('counts tool_use name and input', () => {
    const withTool = estimateTokens([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'rg --json pattern src/' },
          },
        ],
      },
    ]);
    expect(withTool).toBeGreaterThan(estimateTokens([msg('')]));
  });

  it('counts tool_result content', () => {
    const short = estimateTokens([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]);
    const long = estimateTokens([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }],
      },
    ]);
    expect(long).toBeGreaterThan(short * 10);
  });

  it('returns a whole number', () => {
    expect(Number.isInteger(estimateTokens([msg(CHINESE)]))).toBe(true);
  });
});
