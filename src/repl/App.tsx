// Ink REPL — input box + scrolling transcript + status footer.
// Reference: https://github.com/vadimdemedes/ink + ink-text-input examples.

import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useState } from 'react';

import { type AgentState, runAgentTurn } from '../agent/loop.ts';
import { lookupCommand } from '../commands/registry.ts';
import type { Provider } from '../types/messages.ts';

interface Entry {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
}

interface Props {
  provider: Provider;
  state: AgentState;
}

export function App({ provider, state }: Props) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([
    {
      id: 'banner',
      kind: 'system',
      text: `Asterisk REPL — provider: ${provider.name}\nType your message, /help for commands.`,
    },
  ]);

  const append = useCallback((kind: Entry['kind'], text: string) => {
    setEntries((prev) => [
      ...prev,
      { id: `${prev.length}_${Date.now()}`, kind, text },
    ]);
  }, []);

  const onSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || busy) return;
      setInput('');

      const slash = lookupCommand(trimmed);
      if (slash) {
        const out = slash.command.execute(
          { state, providerName: provider.name, exit },
          slash.args,
        );
        append('user', trimmed);
        if (out !== null) append('system', out);
        return;
      }

      append('user', trimmed);
      setBusy(true);
      try {
        await runAgentTurn(provider, state, trimmed, {
          onAssistantText: (t) => append('assistant', t),
          onToolUse: (name, input_) =>
            append('tool', `→ ${name}(${JSON.stringify(input_)})`),
          onToolResult: (name, output, isError) =>
            append(isError ? 'error' : 'tool', `← ${name}: ${output.slice(0, 800)}`),
        });
      } catch (e) {
        append('error', `agent error: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [append, busy, exit, provider, state],
  );

  return (
    <Box flexDirection="column">
      <Static items={entries}>{(entry) => renderEntry(entry)}</Static>
      <Box marginTop={1}>
        {busy ? (
          <Text color="yellow">… working …</Text>
        ) : (
          <>
            <Text color="cyan">› </Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
          </>
        )}
      </Box>
    </Box>
  );
}

function renderEntry(entry: Entry) {
  const color =
    entry.kind === 'user'
      ? 'cyan'
      : entry.kind === 'assistant'
        ? 'white'
        : entry.kind === 'tool'
          ? 'gray'
          : entry.kind === 'system'
            ? 'magenta'
            : 'red';
  const prefix =
    entry.kind === 'user' ? '› ' : entry.kind === 'assistant' ? '· ' : '';
  return (
    <Box key={entry.id} flexDirection="column">
      <Text color={color}>{`${prefix}${entry.text}`}</Text>
    </Box>
  );
}
