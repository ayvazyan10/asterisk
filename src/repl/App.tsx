// Asterisk REPL — bordered input + scrolling transcript + status footer +
// visual command picker triggered by `/`.
// Reference: https://github.com/vadimdemedes/ink + ink-text-input examples.

import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type AgentState, runAgentTurn } from '../agent/loop.ts';
import { lookupCommand } from '../commands/registry.ts';
import { loadConfig } from '../config/load.ts';
import type { McpManager } from '../mcp/manager.ts';
import { loadRules } from '../rules/loader.ts';
import type { Provider } from '../types/messages.ts';
import { Banner } from './Banner.tsx';
import { CommandMenu, clampSelection, filterCommands } from './CommandMenu.tsx';
import { Form } from './forms/Form.tsx';
import { ListPicker } from './forms/ListPicker.tsx';
import type { CommandResult, FormSpec, ListSpec } from './forms/types.ts';
import { detectInlineProtocol, renderInlineImage } from './inline-image.ts';
import { MarkdownText } from './MarkdownText.tsx';
import { StatusBar } from './StatusBar.tsx';
import { WorkingIndicator } from './WorkingIndicator.tsx';

type Modal = FormSpec | ListSpec | null;

const PROGRESS_INTERVAL_MS = 60_000;

const VERSION = '0.1.0';

type EntryKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'tool-result'
  | 'system'
  | 'progress'
  | 'error';

interface Entry {
  id: string;
  kind: EntryKind;
  /** Short, always-shown form (1–2 lines). */
  text: string;
  /** Full payload, revealed when expanded. Absent → text is the whole thing. */
  fullText?: string;
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
  const [workingSince, setWorkingSince] = useState<number | null>(null);
  const [workingStatus, setWorkingStatus] = useState<string>('thinking');
  // Side-question queue: messages the user typed while the agent was busy.
  // Drained automatically when the current turn ends.
  const queueRef = useRef<string[]>([]);
  const [queueLen, setQueueLen] = useState(0);
  const cwd = useMemo(() => process.cwd(), []);

  const menuOpen = !modal && input.startsWith('/');

  // Keep selection inside the filtered list as the user types.
  useEffect(() => {
    setMenuIndex((prev) => clampSelection(input, prev));
  }, [input]);

  const append = useCallback(
    (kind: EntryKind, text: string, fullText?: string) => {
      setEntries((prev) => {
        const id = `${prev.length}_${Date.now()}`;
        const entry: Entry = { id, kind, text };
        if (fullText !== undefined) entry.fullText = fullText;
        return [...prev, entry];
      });
    },
    [],
  );

  // Ctrl+O appends an "expanded" entry below containing the full text of
  // the most recent collapsed entry. Existing entries are immutable (they
  // live inside <Static>) — flipping their expand state would require
  // re-rendering the whole transcript, which is what causes the flicker we
  // had previously. Append-only is cheap and stays compatible with Static.
  useInput(
    (inputChar, key) => {
      if (modal) return;
      if (key.ctrl && (inputChar === 'o' || inputChar === 'O')) {
        setEntries((prev) => {
          const lastCollapsed = [...prev].reverse().find((e) => e.fullText);
          if (!lastCollapsed) return prev;
          const id = `${prev.length}_${Date.now()}_x`;
          const expanded: Entry = {
            id,
            kind: 'system',
            text: `expanded: ${lastCollapsed.text}\n${lastCollapsed.fullText}`,
          };
          return [...prev, expanded];
        });
      }
    },
    { isActive: !modal },
  );

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
      const start = Date.now();
      const tally: Record<string, number> = {};
      let lastTool = '';
      setBusy(true);
      setWorkingSince(start);
      setWorkingStatus('thinking');

      // Drumbeat: every PROGRESS_INTERVAL_MS while still busy, append a
      // progress entry summarising what the agent has been up to since the
      // turn started.
      const progressTimer = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        const minutes = Math.floor(elapsedSec / 60);
        const tallyText =
          Object.keys(tally).length === 0
            ? 'still thinking, no tools called yet'
            : Object.entries(tally)
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => `${count}× ${name}`)
                .join(', ');
        const last = lastTool ? ` · last: ${lastTool}` : '';
        append(
          'progress',
          `still working · ${minutes}m elapsed · ${tallyText}${last}`,
        );
      }, PROGRESS_INTERVAL_MS);

      try {
        const rules = loadRules();
        const hooks = loadConfig().config.hooks;
        const turn = await runAgentTurn(provider, state, text, {
          rules,
          hooks,
          onAssistantText: (t) => {
            setWorkingStatus('writing response');
            append('assistant', t);
          },
          onToolUse: (name, toolInput) => {
            tally[name] = (tally[name] ?? 0) + 1;
            lastTool = name;
            const argsString = formatArgs(toolInput);
            setWorkingStatus(`${name}(${truncate(argsString, 60)})`);
            const oneLine = `${name}(${truncate(argsString, 80)})`;
            const full = `${name}(${argsString})`;
            if (oneLine === full) {
              append('tool', oneLine);
            } else {
              append('tool', oneLine, full);
            }
          },
          onToolResult: (name, output, isError) => {
            setWorkingStatus('thinking');
            const firstLine = output.split('\n')[0] ?? '';
            const oneLine = `${name} → ${truncate(firstLine, 200)}`;
            const full = `${name} →\n${output}`;
            const kind = isError ? 'error' : 'tool-result';
            if (output.length <= 200 && !output.includes('\n')) {
              append(kind, `${name} → ${output}`);
            } else {
              append(kind, oneLine, full);
            }
            // Try to render screenshots inline when the terminal supports it.
            if (name === 'BrowserScreenshot' && !isError) {
              const m = /screenshot saved · (\S.+?)(?:\n|$)/.exec(output);
              const path = m?.[1]?.trim();
              if (path && detectInlineProtocol()) {
                // Side-effect: writes escape sequences directly to stdout.
                renderInlineImage(path);
              }
            }
          },
          onRetry: (attempt, delayMs, why) => {
            setWorkingStatus(`retrying (#${attempt} in ${Math.round(delayMs / 1000)}s)`);
            append('progress', `retrying after ${why} · attempt ${attempt} · waiting ${Math.round(delayMs / 1000)}s`);
          },
          onHook: (result) => {
            const tag = result.exitCode === 0 ? 'hook' : 'hook-err';
            const parts = [`${tag}: ${result.hook}`];
            if (result.stdout.trim()) parts.push(result.stdout.trim());
            if (result.exitCode !== 0 && result.stderr.trim()) parts.push(`stderr: ${result.stderr.trim()}`);
            append(result.exitCode === 0 ? 'tool-result' : 'error', parts.join(' · '));
          },
        });
        if (turn.reason === 'max-turns') {
          append('error', 'reached the per-turn safety cap (12 turns); stopping');
        } else if (turn.reason === 'context-overflow') {
          append('error', 'the conversation exceeded the model context window — try /clear to reset');
        } else if (turn.reason === 'auth-error') {
          append('error', 'authentication failed — check ANTHROPIC_API_KEY or run /config');
        } else if (turn.reason === 'aborted') {
          append('progress', 'turn cancelled');
        }
      } catch (e) {
        append('error', `agent error: ${(e as Error).message}`);
      } finally {
        clearInterval(progressTimer);
        setBusy(false);
        setWorkingSince(null);
        setWorkingStatus('thinking');
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
            injectInput: (text) => setInput(text),
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

  // Resolve a single submitted line into the right action. Used both for
  // direct submits and for queued side questions drained when busy ends.
  const dispatch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      if (!trimmed.startsWith('/')) {
        await runChat(trimmed);
        return;
      }

      const directMatch = lookupCommand(trimmed);
      if (directMatch) {
        await runSlashCommand(trimmed, trimmed);
        return;
      }

      const matches = filterCommands(trimmed);
      if (matches.length === 0) {
        append('user', trimmed);
        append('error', `unknown command: ${trimmed.split(' ')[0]}`);
        return;
      }
      const target = matches[clampSelection(trimmed, menuIndex)];
      if (!target) return;
      const wantsArgs = !!target.usage && /\s/.test(target.usage.trim());
      const namePartOnly = trimmed.indexOf(' ') === -1;
      if (wantsArgs && namePartOnly) {
        // Picker-resolution wanted args we don't have — show usage instead
        // of running blank.
        append('user', trimmed);
        append('error', `${target.name} expects: ${target.usage}`);
        return;
      }
      const space = trimmed.indexOf(' ');
      const argsPart = space === -1 ? '' : trimmed.slice(space);
      const fullCommand = `${target.name}${argsPart}`;
      await runSlashCommand(fullCommand, fullCommand);
    },
    [append, menuIndex, runChat, runSlashCommand],
  );

  const onSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      setInput('');

      // Agent is busy → queue the message. The drainer effect below will
      // run it when the current turn finishes.
      if (busy) {
        queueRef.current.push(trimmed);
        setQueueLen(queueRef.current.length);
        append(
          'progress',
          `queued: "${truncate(trimmed, 80)}" — will run after current turn`,
        );
        return;
      }

      await dispatch(trimmed);
    },
    [append, busy, dispatch],
  );

  // Drain the queue when the agent transitions from busy → idle.
  useEffect(() => {
    if (busy) return;
    if (queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    setQueueLen(queueRef.current.length);
    if (next !== undefined) {
      // queueMicrotask so React's state update for busy=false has flushed.
      queueMicrotask(() => {
        void dispatch(next);
      });
    }
  }, [busy, dispatch]);

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
              onSubmit={(values) => handleFormSubmit(modal, values)}
              onCancel={() => handleFormCancel(modal)}
            />
          ) : (
            <ListPicker
              key={modal.title}
              spec={modal}
              onPick={(v) => handleListPick(modal, v)}
              onCancel={() => handleListCancel(modal)}
            />
          )
        ) : (
          <>
            {busy && workingSince !== null && (
              <Box marginBottom={1} marginLeft={2}>
                <WorkingIndicator since={workingSince} status={workingStatus} />
                {queueLen > 0 && (
                  <Text dimColor>{`  · ${queueLen} queued`}</Text>
                )}
              </Box>
            )}
            <Box
              borderStyle="round"
              borderColor={menuOpen ? 'cyan' : 'gray'}
              paddingX={1}
            >
              <Text color="cyan">{'› '}</Text>
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={onSubmit}
                placeholder={
                  busy
                    ? 'agent is working — your message will run after'
                    : 'ask anything, or / for commands'
                }
              />
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
        <Box key={entry.id} marginTop={1}>
          <Text color="cyan" bold>
            {'› '}
          </Text>
          <Text bold>{entry.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box key={entry.id} marginTop={1} marginBottom={1}>
          <Box marginRight={1}>
            <Text color="cyan">{'⏺ '}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <MarkdownText text={entry.text} />
          </Box>
        </Box>
      );
    case 'tool':
      return (
        <Box key={entry.id} flexDirection="column">
          <Box>
            <Text color="cyan" dimColor>
              {'  → '}
            </Text>
            <Text dimColor>{entry.text}</Text>
          </Box>
          {entry.fullText && (
            <Box marginLeft={4}>
              <Text dimColor>
                {`[+${entry.fullText.length - entry.text.length} chars · Ctrl+O]`}
              </Text>
            </Box>
          )}
        </Box>
      );
    case 'tool-result': {
      const lines = entry.text.split('\n');
      return (
        <Box key={entry.id} flexDirection="column">
          {lines.map((line, i) => (
            <Box key={`${entry.id}_l_${i}`}>
              <Text dimColor>{i === 0 ? '  ← ' : '    '}</Text>
              <Text dimColor>{line}</Text>
            </Box>
          ))}
          {entry.fullText && (
            <Box marginLeft={4}>
              <Text dimColor>{renderCollapseHint(entry.text, entry.fullText)}</Text>
            </Box>
          )}
        </Box>
      );
    }
    case 'system':
      return renderSystemPanel(entry);
    case 'progress':
      return (
        <Box key={entry.id} flexDirection="column" marginTop={1}>
          <Box borderStyle="round" borderColor="yellow" paddingX={2} flexDirection="column">
            <Text color="yellow">{`⏳ ${entry.text}`}</Text>
          </Box>
        </Box>
      );
    case 'error':
      return (
        <Box key={entry.id} flexDirection="column" marginTop={1}>
          <Box borderStyle="round" borderColor="red" paddingX={2} flexDirection="column">
            {entry.text.split('\n').map((line, i) => (
              <Text key={`${entry.id}_e_${i}`} color="red">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      );
    default:
      return <Text key={entry.id}>{entry.text}</Text>;
  }
}

function renderCollapseHint(short: string, full: string): string {
  const fullLines = full.split('\n').length;
  const shortLines = short.split('\n').length;
  const hiddenLines = Math.max(0, fullLines - shortLines);
  if (hiddenLines > 0) return `[+${hiddenLines} more lines · Ctrl+O to expand]`;
  return `[+${full.length - short.length} more chars · Ctrl+O to expand]`;
}

// System output (slash-command results) — render in a soft bordered panel
// with bright text and key/value coloring on lines that look like
// "Label   value" (two-or-more-space separator).
function renderSystemPanel(entry: Entry) {
  const lines = entry.text.split('\n');
  return (
    <Box key={entry.id} flexDirection="column" marginTop={1}>
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={2}
        paddingY={0}
        flexDirection="column"
      >
        {lines.map((line, i) => {
          const id = `${entry.id}_l_${i}`;
          if (line.length === 0) {
            return <Text key={id}> </Text>;
          }
          const kv = parseKeyValue(line);
          if (kv) {
            return (
              <Box key={id}>
                <Text color="cyan">{kv.label}</Text>
                <Text>{kv.gap}</Text>
                <Text>{kv.value}</Text>
              </Box>
            );
          }
          if (line.startsWith('  ✓ ') || line.startsWith('✓ ')) {
            return (
              <Text key={id} color="green">
                {line}
              </Text>
            );
          }
          if (line.startsWith('  ✗ ') || line.startsWith('✗ ')) {
            return (
              <Text key={id} color="red">
                {line}
              </Text>
            );
          }
          return <Text key={id}>{line}</Text>;
        })}
      </Box>
    </Box>
  );
}

// Match "Label   value" — at least two spaces separate the columns. Also
// match "label: value" with one space if the colon is glued to the label.
function parseKeyValue(line: string): { label: string; gap: string; value: string } | null {
  const m = /^([A-Za-z][\w/.\- ]{0,18})(\s{2,})(\S.*)$/.exec(line);
  if (m && m[1] && m[2] && m[3]) return { label: m[1], gap: m[2], value: m[3] };
  const c = /^([A-Za-z][\w/.\- ]{0,18}:)(\s+)(\S.*)$/.exec(line);
  if (c && c[1] && c[2] && c[3]) return { label: c[1], gap: c[2], value: c[3] };
  return null;
}

function formatArgs(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return truncate(json, 120);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}
