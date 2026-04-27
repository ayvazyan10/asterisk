// Interactive `asterisk configure` wizard. Built on Ink + ink-text-input,
// walks the user through the minimum config needed to enable each feature.

import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import { loadConfig, saveConfig, saveSecrets } from './load.ts';
import type { AsteriskConfig } from './schema.ts';

interface Step {
  key: string;
  prompt: string;
  initial: (state: WizardState) => string;
  apply: (state: WizardState, value: string) => WizardState;
  optional?: boolean;
}

interface WizardState {
  config: AsteriskConfig;
  secrets: Record<string, string>;
}

const STEPS: Step[] = [
  {
    key: 'provider',
    prompt: 'Provider — type "ollama" or "anthropic"',
    initial: (s) => s.config.provider,
    apply: (s, v) => {
      const p = v.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'ollama';
      return { ...s, config: { ...s.config, provider: p } };
    },
  },
  {
    key: 'ollama.baseUrl',
    prompt: 'Ollama base URL',
    initial: (s) => s.config.ollama.baseUrl,
    apply: (s, v) => ({
      ...s,
      config: { ...s.config, ollama: { ...s.config.ollama, baseUrl: v.trim() || s.config.ollama.baseUrl } },
    }),
  },
  {
    key: 'ollama.model',
    prompt: 'Ollama model',
    initial: (s) => s.config.ollama.model,
    apply: (s, v) => ({
      ...s,
      config: { ...s.config, ollama: { ...s.config.ollama, model: v.trim() || s.config.ollama.model } },
    }),
  },
  {
    key: 'ANTHROPIC_API_KEY',
    prompt: 'Anthropic API key (leave blank to skip)',
    initial: (s) => s.secrets['ANTHROPIC_API_KEY'] ?? '',
    apply: (s, v) => ({ ...s, secrets: { ...s.secrets, ANTHROPIC_API_KEY: v.trim() } }),
    optional: true,
  },
  {
    key: 'telegram.enabled',
    prompt: 'Enable Telegram bot? (y/n)',
    initial: (s) => (s.config.bots.telegram.enabled ? 'y' : 'n'),
    apply: (s, v) => ({
      ...s,
      config: {
        ...s.config,
        bots: { ...s.config.bots, telegram: { ...s.config.bots.telegram, enabled: yesno(v) } },
      },
    }),
  },
  {
    key: 'ASTERISK_TELEGRAM_BOT_TOKEN',
    prompt: 'Telegram bot token (from @BotFather; blank to skip)',
    initial: (s) => s.secrets['ASTERISK_TELEGRAM_BOT_TOKEN'] ?? '',
    apply: (s, v) => ({ ...s, secrets: { ...s.secrets, ASTERISK_TELEGRAM_BOT_TOKEN: v.trim() } }),
    optional: true,
  },
  {
    key: 'telegram.allowedUserIds',
    prompt: 'Allowed Telegram user IDs (comma-separated; blank to skip)',
    initial: (s) => s.config.bots.telegram.allowedUserIds.join(','),
    apply: (s, v) => {
      const ids = v
        .split(',')
        .map((x) => Number.parseInt(x.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      return {
        ...s,
        config: {
          ...s.config,
          bots: {
            ...s.config.bots,
            telegram: { ...s.config.bots.telegram, allowedUserIds: ids },
          },
        },
      };
    },
  },
  {
    key: 'telegram.streamMode',
    prompt:
      'Telegram reply mode — "final" (one message at end), "status" (live tool-call status, final reply replaces it), "stream" (text streams live)',
    initial: (s) => s.config.bots.telegram.streamMode,
    apply: (s, v) => {
      const raw = v.trim().toLowerCase();
      const mode = raw === 'status' || raw === 'stream' ? raw : 'final';
      return {
        ...s,
        config: {
          ...s.config,
          bots: {
            ...s.config.bots,
            telegram: { ...s.config.bots.telegram, streamMode: mode },
          },
        },
      };
    },
  },
  {
    key: 'telegram.parseMode',
    prompt:
      'Telegram text formatting — "html" renders **bold**, *italic*, `code`, links; "plain" leaves markdown markers visible',
    initial: (s) => s.config.bots.telegram.parseMode,
    apply: (s, v) => {
      const raw = v.trim().toLowerCase();
      const mode = raw === 'plain' ? 'plain' : 'html';
      return {
        ...s,
        config: {
          ...s.config,
          bots: {
            ...s.config.bots,
            telegram: { ...s.config.bots.telegram, parseMode: mode },
          },
        },
      };
    },
  },
  {
    key: 'whatsapp.enabled',
    prompt: 'Enable WhatsApp bot? (y/n)',
    initial: (s) => (s.config.bots.whatsapp.enabled ? 'y' : 'n'),
    apply: (s, v) => ({
      ...s,
      config: {
        ...s.config,
        bots: { ...s.config.bots, whatsapp: { ...s.config.bots.whatsapp, enabled: yesno(v) } },
      },
    }),
  },
  {
    key: 'whatsapp.transport',
    prompt:
      'WhatsApp transport — "meta-cloud" (official, recommended) or "web-js" (unofficial; violates WhatsApp ToS, personal use only)',
    initial: (s) => s.config.bots.whatsapp.transport,
    apply: (s, v) => {
      const t = v.trim().toLowerCase() === 'web-js' ? 'web-js' : 'meta-cloud';
      return {
        ...s,
        config: {
          ...s.config,
          bots: { ...s.config.bots, whatsapp: { ...s.config.bots.whatsapp, transport: t } },
        },
      };
    },
  },
  {
    key: 'ASTERISK_WHATSAPP_META_TOKEN',
    prompt: 'WhatsApp Meta Cloud access token (blank to skip)',
    initial: (s) => s.secrets['ASTERISK_WHATSAPP_META_TOKEN'] ?? '',
    apply: (s, v) => ({ ...s, secrets: { ...s.secrets, ASTERISK_WHATSAPP_META_TOKEN: v.trim() } }),
    optional: true,
  },
  {
    key: 'ASTERISK_WHATSAPP_VERIFY_TOKEN',
    prompt: 'WhatsApp webhook verify token (blank to skip)',
    initial: (s) => s.secrets['ASTERISK_WHATSAPP_VERIFY_TOKEN'] ?? '',
    apply: (s, v) => ({
      ...s,
      secrets: { ...s.secrets, ASTERISK_WHATSAPP_VERIFY_TOKEN: v.trim() },
    }),
    optional: true,
  },
];

function yesno(v: string): boolean {
  const t = v.trim().toLowerCase();
  return t === 'y' || t === 'yes' || t === 'true' || t === '1';
}

export function ConfigureWizard() {
  const { exit } = useApp();
  const initial = loadConfig();
  const [state, setState] = useState<WizardState>({
    config: initial.config,
    secrets: { ...(initial.secrets as Record<string, string>) },
  });
  const [stepIndex, setStepIndex] = useState(0);
  const [input, setInput] = useState<string>(STEPS[0]?.initial(state) ?? '');
  const [history, setHistory] = useState<string[]>([
    'asterisk configure — answers persist to ~/.asterisk/{config.json,secrets.env}',
    'Press Enter to accept the shown default; ^C aborts without saving.',
  ]);

  const step = STEPS[stepIndex];
  if (!step) {
    return null;
  }

  const onSubmit = (raw: string) => {
    const value = raw.length > 0 ? raw : step.initial(state);
    const nextState = step.apply(state, value);
    const display = step.key.toLowerCase().includes('token') || step.key.includes('API_KEY')
      ? value ? '<redacted>' : '(skipped)'
      : value || '(default)';
    const next: string[] = [...history, `${step.prompt}: ${display}`];

    if (stepIndex + 1 >= STEPS.length) {
      try {
        saveConfig(nextState.config);
        saveSecrets(nextState.secrets);
        next.push('saved ~/.asterisk/config.json and ~/.asterisk/secrets.env');
      } catch (e) {
        next.push(`SAVE FAILED: ${(e as Error).message}`);
      }
      setHistory(next);
      setState(nextState);
      setTimeout(exit, 50);
      return;
    }

    const nextStep = STEPS[stepIndex + 1];
    setHistory(next);
    setState(nextState);
    setStepIndex(stepIndex + 1);
    setInput(nextStep ? nextStep.initial(nextState) : '');
  };

  return (
    <Box flexDirection="column">
      <Static items={history.map((line, i) => ({ id: `h_${i}`, line }))}>
        {(entry) => <Text key={entry.id}>{entry.line}</Text>}
      </Static>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">{step.prompt}</Text>
        <Box>
          <Text>› </Text>
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
        </Box>
      </Box>
    </Box>
  );
}
