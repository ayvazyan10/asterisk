// Asterisk REPL — bordered input + scrolling transcript + status footer.
// Reference: https://github.com/vadimdemedes/ink + ink-text-input examples.

import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useMemo, useState } from 'react';

import { type AgentState, runAgentTurn } from '../agent/loop.ts';
import { lookupCommand } from '../commands/registry.ts';
import type { McpManager } from '../mcp/manager.ts';
import type { Provider } from '../types/messages.ts';
import { Banner } from './Banner.tsx';
import { StatusBar } from './StatusBar.tsx';

const VERSION = '0.1.0';

type EntryKind = 'user' | 'assistant' | 'tool' | 'tool-result' | 'system' | 'error';

interface Entry {
  id: string;
  kind: EntryKind;
  text: string;
}

interface Props {
  initialProvider: Provider;
  state: AgentState;
  mcp: McpManager;
}

export function App({ initialProvider, state, mcp }: Props) {
  const { exit } = useApp();
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const cwd = useMemo(() => process.cwd(), []);

  const append = useCallback((kind: EntryKind, text: string) => {
    setEntries((prev) => [...prev, { id: `${prev.length}_${Date.now()}`, kind, text }]);
  }, []);

  const onSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || busy) return;
      setInput('');

      const slash = lookupCommand(trimmed);
      if (slash) {
        append('user', trimmed);
        try {
          const out = await slash.command.execute(
            {
              state,
              provider,
              setProvider,
              clearHistory: () => {
                state.history.length = 0;
              },
              exit,
              mcp,
            },
            slash.args,
          );
          if (out !== null && out !== undefined) append('system', out);
        } catch (e) {
          append('error', `command error: ${(e as Error).message}`);
        }
        return;
      }

      append('user', trimmed);
      setBusy(true);
      try {
        await runAgentTurn(provider, state, trimmed, {
          onAssistantText: (t) => append('assistant', t),
          onToolUse: (name, toolInput) =>
            append('tool', `${name}(${formatArgs(toolInput)})`),
          onToolResult: (name, output, isError) =>
            append(isError ? 'error' : 'tool-result', `${name} → ${truncate(output, 800)}`),
        });
      } catch (e) {
        append('error', `agent error: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [append, busy, exit, mcp, provider, state],
  );

  return (
    <Box flexDirection="column">
      <Static items={[{ id: '__banner__' } as Entry, ...entries]}>
        {(entry) => {
          if (entry.id === '__banner__') {
            return (
              <Banner key="__banner__" providerName={provider.name} cwd={cwd} version={VERSION} />
            );
          }
          return renderEntry(entry);
        }}
      </Static>
      <Box flexDirection="column" marginTop={1}>
        <Box
          borderStyle="round"
          borderColor={busy ? 'yellow' : 'gray'}
          paddingX={1}
        >
          <Text color="cyan">{busy ? '◐ ' : '› '}</Text>
          {busy ? (
            <Text color="yellow">working…</Text>
          ) : (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder="ask anything, or /help"
            />
          )}
        </Box>
        <StatusBar
          providerName={provider.name}
          historyCount={state.history.length}
          cwd={cwd}
          busy={busy}
        />
      </Box>
    </Box>
  );
}

function renderEntry(entry: Entry) {
  switch (entry.kind) {
    case 'user':
      return (
        <Box key={entry.id}>
          <Text color="cyan">{'› '}</Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box key={entry.id} flexDirection="column" marginTop={1}>
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'tool':
      return (
        <Box key={entry.id}>
          <Text color="cyan" dimColor>
            {'  → '}
          </Text>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
    case 'tool-result':
      return (
        <Box key={entry.id}>
          <Text dimColor>{'  ← '}</Text>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
    case 'system':
      return (
        <Box key={entry.id} flexDirection="column" marginTop={1}>
          <Text color="magenta" dimColor>
            {entry.text}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box key={entry.id} flexDirection="column" marginTop={1}>
          <Text color="red">{entry.text}</Text>
        </Box>
      );
    default:
      return <Text key={entry.id}>{entry.text}</Text>;
  }
}

function formatArgs(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return truncate(json, 120);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}
