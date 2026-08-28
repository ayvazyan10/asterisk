// The message catalogue.
//
// English is the source of truth: `MessageKey` is a union over its keys, so a
// key that does not exist is a compile error at every call site, and a
// translation that invents one is a compile error here. A translation may be
// incomplete — the missing entries fall back to English at runtime — but it
// cannot drift into naming things that do not exist.
//
// What belongs here is what the *user* reads. Tool names, tool descriptions,
// the system prompt and tool results are read by the model and stay English;
// see the header of index.ts for why that is a correctness boundary rather
// than laziness.

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

const en = {
  // Status bar
  'status.provider': 'provider',
  'status.messages': 'messages',
  'status.plan': 'plan mode',
  'status.queued': '{count} queued',

  // Working indicator
  'working.thinking': 'thinking',
  'working.elapsed': '{seconds}s',
  'working.chars': '{count} chars',
  'working.escToCancel': 'esc to interrupt',

  // Forms and pickers
  'form.submit': 'Submit',
  'form.cancel': 'Esc to cancel',
  'form.required': '{label} is required',
  'form.enterToConfirm': 'Enter to confirm',
  'form.yes': 'yes',
  'form.no': 'no',
  'list.empty': '(nothing to choose from)',
  'list.navigate': '↑↓ to move · Enter to pick · Esc to cancel',

  // Approval prompt
  'approval.title': 'Approve this command?',
  'approval.because': 'Needs approval because {reason}.',
  'approval.notASandbox':
    'Approving runs it with your full privileges — this is a consent check, not a sandbox.',
  'approval.allowOnce': 'Allow once',
  'approval.allowOnceHelp': 'Run it this time only.',
  'approval.allowAlways': 'Allow always',
  'approval.allowAlwaysHelp': 'Remember {rules} and stop asking.',
  'approval.allowAlwaysHelpGeneric':
    'Nothing to remember — this command is too specific to match again.',
  'approval.deny': 'Deny',
  'approval.denyHelp': 'Refuse, and tell the agent not to retry.',

  // Ask
  'ask.yourAnswer': 'Your answer',

  // Transcript
  // Two keys rather than one with a noun substituted in: a sentence built by
  // dropping a fragment into a slot only reads correctly in the language it
  // was designed in. Russian needs a different case for each.
  'transcript.expandHintLines': '[+{count} more lines · Ctrl+O to expand]',
  'transcript.expandHintChars': '[+{count} more chars · Ctrl+O to expand]',
  'transcript.expanded': 'expanded: {label}',
  'transcript.noReply': '(no reply)',
} as const;

export type MessageKey = keyof typeof en;

/**
 * Russian. Incomplete entries are legal — they fall back to English — but a
 * key not present in `en` will not compile.
 */
const ru: Partial<Record<MessageKey, string>> = {
  'status.provider': 'провайдер',
  'status.messages': 'сообщений',
  'status.plan': 'режим плана',
  'status.queued': 'в очереди: {count}',

  'working.thinking': 'думает',
  'working.elapsed': '{seconds} с',
  'working.chars': 'знаков: {count}',
  'working.escToCancel': 'esc — прервать',

  'form.submit': 'Отправить',
  'form.cancel': 'Esc — отмена',
  'form.required': 'поле «{label}» обязательно',
  'form.enterToConfirm': 'Enter — подтвердить',
  'form.yes': 'да',
  'form.no': 'нет',
  'list.empty': '(выбирать не из чего)',
  'list.navigate': '↑↓ — выбор · Enter — принять · Esc — отмена',

  'approval.title': 'Разрешить эту команду?',
  'approval.because': 'Требует подтверждения, потому что {reason}.',
  'approval.notASandbox':
    'Одобренная команда исполняется с вашими полными правами — это проверка согласия, а не песочница.',
  'approval.allowOnce': 'Разрешить один раз',
  'approval.allowOnceHelp': 'Выполнить только сейчас.',
  'approval.allowAlways': 'Разрешать всегда',
  'approval.allowAlwaysHelp': 'Запомнить {rules} и больше не спрашивать.',
  'approval.allowAlwaysHelpGeneric':
    'Запомнить нечего — команда слишком специфична, чтобы совпасть снова.',
  'approval.deny': 'Отказать',
  'approval.denyHelp': 'Отказать и сообщить агенту, чтобы не повторял.',

  'ask.yourAnswer': 'Ваш ответ',

  'transcript.expandHintLines': '[ещё {count} строк · Ctrl+O — развернуть]',
  'transcript.expandHintChars': '[ещё {count} знаков · Ctrl+O — развернуть]',
  'transcript.expanded': 'развёрнуто: {label}',
  'transcript.noReply': '(нет ответа)',
};

export const MESSAGES: Record<Locale, Partial<Record<MessageKey, string>>> & {
  en: Record<MessageKey, string>;
} = { en, ru };
