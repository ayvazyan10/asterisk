// Asterisk REPL — bordered input + scrolling transcript + status footer +
// visual command picker triggered by `/`.
// Reference: https://github.com/vadimdemedes/ink + ink-text-input examples.

import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { type AgentState, runAgentTurn } from '../agent/loop.ts';
import { lookupCommand } from '../commands/registry.ts';
import type { McpManager } from '../mcp/manager.ts';
import type { Provider } from '../types/messages.ts';
import { Banner } from './Banner.tsx';
import { CommandMenu, clampSelection, filterCommands } from './CommandMenu.tsx';
import { Form } from './forms/Form.tsx';
import { ListPicker } from './forms/ListPicker.tsx';
import type { CommandResult, FormSpec, ListSpec } from './forms/types.ts';
import { StatusBar } from './StatusBar.tsx';

type Modal = FormSpec | ListSpec | null;

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
  const [menuIndex, setMenuIndex] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const cwd = useMemo(() => process.cwd(), []);

  const menuOpen = !modal && input.startsWith('/');

  // Keep selection inside the filtered list as the user types.
  useEffect(() => {
    setMenuIndex((prev) => clampSelection(input, prev));
  }, [input]);

  const append = useCallback((kind: EntryKind, text: string) => {
    setEntries((prev) => [...prev, { id: `${prev.length}_${Date.now()}`, kind, text }]);
  }, []);

  // Recursively apply a CommandResult: text → transcript, null → no-op,
  // FormSpec/ListSpec → open the modal.
  const applyResult = useCallback(
    (result: CommandResult) => {
      if (result === null || result === undefined) {
        setModal(null);
        return;
      }
      if (typeof result === 'string') {
        if (result.length > 0) append('system', result);
        setModal(null);
        return;
      }
      setModal(result);
    },
    [append],
  );

  const handleFormSubmit = useCallback(
    async (spec: FormSpec, values: Record<string, string>) => {
      try {
        const next = await spec.onSubmit(values);
        applyResult(next);
      } catch (e) {
        append('error', `form error: ${(e as Error).message}`);
        setModal(null);
      }
    },
    [append, applyResult],
  );

  const handleFormCancel = useCallback(
    async (spec: FormSpec) => {
      try {
        const next = (await spec.onCancel?.()) ?? null;
        applyResult(next);
      } catch (e) {
        append('error', `form error: ${(e as Error).message}`);
        setModal(null);
      }
    },
    [append, applyResult],
  );

  const handleListPick = useCallback(
    async (spec: ListSpec, value: string) => {
      try {
        const next = await spec.onPick(value);
        applyResult(next);
      } catch (e) {
        append('error', `list error: ${(e as Error).message}`);
        setModal(null);
      }
    },
    [append, applyResult],
  );

  const handleListCancel = useCallback(
    async (spec: ListSpec) => {
      try {
        const next = (await spec.onCancel?.()) ?? null;
        applyResult(next);
      } catch (e) {
        append('error', `list error: ${(e as Error).message}`);
        setModal(null);
      }
    },
    [append, applyResult],
  );

  // Picker key handling. ink-text-input ignores up/down arrows and tab, so we
  // can safely intercept those without conflicting with the text editor.
  useInput(
    (_char, key) => {
      if (!menuOpen || busy) return;
      const matches = filterCommands(input);
      if (matches.length === 0) {
        if (key.escape) setInput('');
        return;
      }

      if (key.upArrow) {
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (key.downArrow) {
        setMenuIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (key.tab) {
        const target = matches[clampSelection(input, menuIndex)];
        if (!target) return;
        const wantsArgs = !!target.usage && /\s/.test(target.usage.trim());
        setInput(wantsArgs ? `${target.name} ` : target.name);
        return;
      }
      if (key.escape) {
        setInput('');
      }
    },
    { isActive: menuOpen },
  );

  const runChat = useCallback(
    async (text: string) => {
      append('user', text);
      setBusy(true);
      try {
        await runAgentTurn(provider, state, text, {
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
    [append, provider, state],
  );

  const runSlashCommand = useCallback(
    async (commandLine: string, displayInput: string) => {
      const cmd = lookupCommand(commandLine);
      if (!cmd) {
        append('user', displayInput);
        append('error', `unknown command: ${commandLine.split(' ')[0]}`);
        return;
      }
      append('user', displayInput);
      try {
        const out = await cmd.command.execute(
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
          cmd.args,
        );
        applyResult(out);
      } catch (e) {
        append('error', `command error: ${(e as Error).message}`);
      }
    },
    [append, applyResult, exit, mcp, provider, state],
  );

  const onSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || busy) return;

      if (!trimmed.startsWith('/')) {
        setInput('');
        await runChat(trimmed);
        return;
      }

      // Slash path. If the user typed an exact name we run it. If it's a
      // partial name with a unique highlighted match we either complete-and-
      // wait (when the command takes args) or run the highlighted one.
      const directMatch = lookupCommand(trimmed);
      if (directMatch) {
        setInput('');
        await runSlashCommand(trimmed, trimmed);
        return;
      }

      const matches = filterCommands(trimmed);
      if (matches.length === 0) {
        setInput('');
        append('user', trimmed);
        append('error', `unknown command: ${trimmed.split(' ')[0]}`);
        return;
      }
      const target = matches[clampSelection(trimmed, menuIndex)];
      if (!target) {
        setInput('');
        return;
      }
      const wantsArgs = !!target.usage && /\s/.test(target.usage.trim());
      const namePartOnly = trimmed.indexOf(' ') === -1;
      if (wantsArgs && namePartOnly) {
        setInput(`${target.name} `);
        return;
      }
      setInput('');
      await runSlashCommand(target.name, trimmed);
    },
    [append, busy, menuIndex, runChat, runSlashCommand],
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
        {modal ? (
          modal.kind === 'form' ? (
            <Form
              key={modal.title}
              spec={modal}
              onComplete={() => setModal(null)}
              onSubmit={(values) => handleFormSubmit(modal, values)}
              onCancel={() => handleFormCancel(modal)}
            />
          ) : (
            <ListPicker
              key={modal.title}
              spec={modal}
              onComplete={() => setModal(null)}
              onPick={(v) => handleListPick(modal, v)}
              onCancel={() => handleListCancel(modal)}
            />
          )
        ) : (
          <>
            <Box
              borderStyle="round"
              borderColor={busy ? 'yellow' : menuOpen ? 'cyan' : 'gray'}
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
                  placeholder="ask anything, or / for commands"
                />
              )}
            </Box>
            <CommandMenu input={input} selectedIndex={menuIndex} />
          </>
        )}
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
