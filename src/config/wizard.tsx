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
    prompt: 'Provider — "openai-compatible" (local) or "anthropic"',
    initial: (s) => s.config.provider,
    apply: (s, v) => {
      const typed = v.trim().toLowerCase();
      // Anything that is not clearly Anthropic means the local endpoint —
      // that is the default, and an unrecognised answer should land there
      // rather than silently selecting a hosted API that needs a key.
      const p = typed === 'anthropic' ? 'anthropic' : 'openai-compatible';
      return { ...s, config: { ...s.config, provider: p } };
    },
  },
  {
    key: 'openaiCompatible.baseUrl',
    prompt: 'OpenAI-compatible base URL (llama.cpp, LM Studio, vLLM…)',
    initial: (s) => s.config.openaiCompatible.baseUrl,
    apply: (s, v) => ({
      ...s,
      config: {
        ...s.config,
        openaiCompatible: {
          ...s.config.openaiCompatible,
          baseUrl: v.trim() || s.config.openaiCompatible.baseUrl,
        },
      },
    }),
  },
  {
    key: 'openaiCompatible.model',
    prompt: 'OpenAI-compatible model id (blank = server default)',
    initial: (s) => s.config.openaiCompatible.model,
    apply: (s, v) => ({
      ...s,
      config: {
        ...s.config,
        openaiCompatible: { ...s.config.openaiCompatible, model: v.trim() },
      },
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
    'asterisk configure — answers persist to ~/.asterisk/asterisk.db',
    'Press Enter to accept the shown default; ^C aborts without saving.',
    'For every setting at once, try `asterisk web`.',
  ]);

  const step = STEPS[stepIndex];
  if (!step) {
    return null;
  }

  const onSubmit = (raw: string) => {
    const value = raw.length > 0 ? raw : step.initial(state);
    const nextState = step.apply(state, value);
    const display =
      step.key.toLowerCase().includes('token') || step.key.includes('API_KEY')
        ? value
          ? '<redacted>'
          : '(skipped)'
        : value || '(default)';
    const next: string[] = [...history, `${step.prompt}: ${display}`];

    if (stepIndex + 1 >= STEPS.length) {
      try {
        saveConfig(nextState.config);
        saveSecrets(nextState.secrets);
        next.push('saved to ~/.asterisk/asterisk.db');
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
