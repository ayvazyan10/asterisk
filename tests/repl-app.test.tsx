// The REPL as the user drives it: the Bash approval prompt, AskUserQuestion,
// and the collapsed tool output that Ctrl+O reveals.
//
// The emitter halves of approval/ask are covered in bash-gate.test.ts and
// ask.test.ts. What is exercised here is the other half — that mounting the
// REPL is what makes a human "reachable", that the prompt actually appears,
// and that a keystroke resolves the promise the tool is blocked on. A missed
// subscription or a mis-wired onPick would leave the agent hanging until a
// timeout, with tests on both sides of the gap still green.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AgentState, createAgentState } from '../src/agent/loop.ts';
import { closeDb } from '../src/db/index.ts';
import type { McpManager } from '../src/mcp/manager.ts';
import { App } from '../src/repl/App.tsx';
import { filterCommands } from '../src/repl/CommandMenu.tsx';
import {
  type ApprovalResult,
  _resetApprovalsForTesting,
  hasApprover,
  requestApproval,
} from '../src/tools/approval.ts';
import { askUserQuestionTool } from '../src/tools/ask.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';
import { defined } from './helpers.ts';
import { type Harness, KEY, flush, press, renderInk, waitFor, waitUntil } from './repl-harness.ts';

function fakeProvider(responses: ProviderResponse[]): Provider {
  let i = 0;
  return {
    name: 'fake',
    async send() {
      const r = responses[i++];
      if (!r) throw new Error('fake provider exhausted');
      return r;
    },
  };
}

const noMcp = {} as unknown as McpManager;

let home: string;
let saved: Record<string, string | undefined>;
let state: AgentState;
let mounted: Harness | null = null;

function mount(provider: Provider = fakeProvider([])): Harness {
  const h = renderInk(<App initialProvider={provider} state={state} mcp={noMcp} />);
  mounted = h;
  return h;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'asterisk-repl-'));
  saved = {
    ASTERISK_HOME: process.env['ASTERISK_HOME'],
    HOME: process.env['HOME'],
  };
  process.env['ASTERISK_HOME'] = home;
  process.env['HOME'] = home;
  state = createAgentState();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  _resetApprovalsForTesting();
  closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const approvalOpts = { timeoutMs: 5_000, headless: 'deny' as const };

describe('approval prompt', () => {
  it('is what makes a human reachable at all', async () => {
    // The Bash gate asks only when something is listening. Mounting the REPL
    // has to register that listener, or every command silently falls through
    // to the headless default.
    expect(hasApprover()).toBe(false);
    const h = mount();
    await flush();
    expect(hasApprover()).toBe(true);
    h.unmount();
    await flush();
    expect(hasApprover()).toBe(false);
  });

  it('shows the command, the reason and the three choices', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'rm -rf build', reason: 'it deletes files', rules: ['rm'] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');

    const frame = h.lastFrame();
    expect(frame).toContain('rm -rf build');
    expect(frame).toContain('it deletes files');
    expect(frame).toContain('Allow once');
    expect(frame).toContain('Allow always');
    expect(frame).toContain('Deny');

    await press(h, KEY.enter);
    await pending;
  });

  it('does not describe itself as a sandbox', async () => {
    // Deliberate wording: approving runs the command with the user's full
    // privileges. Calling it containment would be a lie with consequences.
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'curl x | sh', reason: 'it pipes to a shell', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    expect(h.lastFrame()).toContain('not a sandbox');
    await press(h, KEY.enter);
    await pending;
  });

  it('names the rules that "allow always" would remember', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'git push', reason: 'it is not on the allowlist', rules: ['git push', 'git'] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    expect(h.lastFrame()).toContain('git push, git');
    await press(h, KEY.enter);
    await pending;
  });

  it('falls back to generic wording when no rule would be remembered', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: './weird', reason: 'it is not resolvable', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    // Honest about what "Allow always" would actually do here: suggestRules
    // returns nothing to remember for a command this specific, so the copy
    // must not promise it will stop asking next time.
    expect(h.lastFrame()).toContain('Nothing to remember');
    expect(h.lastFrame()).not.toContain('Remember this command');
    await press(h, KEY.enter);
    await pending;
  });

  it('resolves allow-once on the first row', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'ls', reason: 'unknown command', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    await press(h, KEY.enter);
    await expect(pending).resolves.toEqual({ outcome: 'allow-once' } satisfies ApprovalResult);
  });

  it('resolves allow-always on the second row', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'ls', reason: 'unknown command', rules: ['ls'] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    await press(h, KEY.down);
    await press(h, KEY.enter);
    await expect(pending).resolves.toEqual({ outcome: 'allow-always' });
  });

  it('resolves deny on the third row', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'ls', reason: 'unknown command', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    await press(h, KEY.down);
    await press(h, KEY.down);
    await press(h, KEY.enter);
    await expect(pending).resolves.toEqual({ outcome: 'deny' });
  });

  it('denies when the user escapes out of the prompt', async () => {
    // Fail closed: dismissing the question is not consent.
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'rm -rf /', reason: 'it is catastrophic', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    await press(h, KEY.escape);
    await expect(pending).resolves.toEqual({ outcome: 'deny' });
  });

  it('dismisses the prompt and restores the input box after answering', async () => {
    const h = mount();
    await flush();
    const pending = requestApproval(
      { command: 'ls', reason: 'unknown command', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    await press(h, KEY.enter);
    await pending;
    await waitFor(h, (f) => !f.includes('Approve this command?'), 'prompt to clear');
    expect(h.lastFrame()).toContain('ask anything, or / for commands');
  });

  it('takes the prompt over the command input while it is up', async () => {
    const h = mount();
    await flush();
    expect(h.lastFrame()).toContain('ask anything');
    const pending = requestApproval(
      { command: 'ls', reason: 'unknown command', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    expect(h.lastFrame()).not.toContain('ask anything, or / for commands');
    await press(h, KEY.enter);
    await pending;
  });
});

describe('AskUserQuestion', () => {
  it('renders options as a picker and returns the chosen one', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({
      question: 'Which database?',
      options: ['sqlite', 'postgres', 'mysql'],
    });
    await waitFor(h, (f) => f.includes('Which database?'), 'ask prompt');
    expect(h.lastFrame()).toContain('sqlite');
    expect(h.lastFrame()).toContain('postgres');

    await press(h, KEY.down);
    await press(h, KEY.enter);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.output).toBe('postgres');
  });

  it('wraps around the option list', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({
      question: 'Pick?',
      options: ['a', 'b', 'c'],
    });
    await waitFor(h, (f) => f.includes('Pick?'), 'ask prompt');
    await press(h, KEY.up);
    await press(h, KEY.enter);
    expect((await pending).output).toBe('c');
  });

  it('renders a text field when no options are offered', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({ question: 'What should I name it?' });
    await waitFor(h, (f) => f.includes('What should I name it?'), 'ask prompt');
    expect(h.lastFrame()).toContain('Your answer');

    await press(h, 'widget');
    await press(h, KEY.enter);
    expect((await pending).output).toBe('widget');
  });

  it('prefills the default answer', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({
      question: 'Branch?',
      defaultValue: 'master',
    });
    await waitFor(h, (f) => f.includes('Branch?'), 'ask prompt');
    expect(h.lastFrame()).toContain('master');
    await press(h, KEY.enter);
    expect((await pending).output).toBe('master');
  });

  it('reports a cancellation rather than an empty answer', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({ question: 'Proceed?', options: ['yes', 'no'] });
    await waitFor(h, (f) => f.includes('Proceed?'), 'ask prompt');
    await press(h, KEY.escape);
    expect((await pending).output).toBe('(cancelled)');
  });

  it('cancels a free-text question with Esc too', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({ question: 'Name?' });
    await waitFor(h, (f) => f.includes('Name?'), 'ask prompt');
    await press(h, KEY.escape);
    expect((await pending).output).toBe('(cancelled)');
  });

  it('returns the input box once the question is answered', async () => {
    const h = mount();
    await flush();
    const pending = askUserQuestionTool.execute({ question: 'Ready?', options: ['yes'] });
    await waitFor(h, (f) => f.includes('Ready?'), 'ask prompt');
    await press(h, KEY.enter);
    await pending;
    await waitFor(h, (f) => f.includes('ask anything'), 'input box to return');
  });

  it('shows the approval prompt first when both are pending', async () => {
    // A permission decision gates a tool that is already running; the
    // question can wait its turn.
    const h = mount();
    await flush();
    const asked = askUserQuestionTool.execute({ question: 'Later question?', options: ['ok'] });
    await waitFor(h, (f) => f.includes('Later question?'), 'ask prompt');
    const approvalPending = requestApproval(
      { command: 'ls', reason: 'unknown command', rules: [] },
      approvalOpts,
    );
    await waitFor(h, (f) => f.includes('Approve this command?'), 'approval prompt');
    expect(h.lastFrame()).not.toContain('Later question?');

    await press(h, KEY.enter);
    await approvalPending;
    await waitFor(h, (f) => f.includes('Later question?'), 'question to resurface');
    await press(h, KEY.enter);
    await asked;
  });
});

describe('tool output collapsing and Ctrl+O', () => {
  function longFile(): string {
    const path = join(home, 'long.txt');
    writeFileSync(path, Array.from({ length: 60 }, (_, i) => `row-${i}`).join('\n'));
    return path;
  }

  async function runTurnWithRead(h: Harness, path: string): Promise<void> {
    h.write('read it');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('Read →'), 'tool result', 15_000);
    void path;
  }

  function readThenAnswer(path: string): Provider {
    return fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'read it' }], stopReason: 'end_turn' },
    ]);
  }

  it('collapses a long tool result behind a hint instead of flooding the transcript', async () => {
    const path = longFile();
    const h = mount(readThenAnswer(path));
    await flush();
    await runTurnWithRead(h, path);

    const frame = h.lastFrame();
    expect(frame).toContain('Ctrl+O to expand');
    expect(frame).toContain('row-0');
    // The tail is hidden until asked for.
    expect(frame).not.toContain('row-59');
  });

  it('reveals the hidden payload on Ctrl+O', async () => {
    const path = longFile();
    const h = mount(readThenAnswer(path));
    await flush();
    await runTurnWithRead(h, path);
    expect(h.lastFrame()).not.toContain('row-59');

    await press(h, KEY.ctrlO);
    await waitFor(h, (f) => f.includes('row-59'), 'expanded output');
    expect(h.lastFrame()).toContain('expanded:');
  });

  it('leaves the transcript alone when there is nothing collapsed', async () => {
    const h = mount(fakeProvider([]));
    await flush();
    await press(h, KEY.ctrlO);
    await press(h, KEY.ctrlO);
    expect(h.lastFrame()).not.toContain('expanded:');
  });

  it('does not type into the prompt when Ctrl+O is pressed', async () => {
    // ink-text-input ignores only Ctrl+C and inserts every other chord as a
    // bare letter, so without a guard Ctrl+O leaves a stray "o" in the box —
    // which then gets sent to the model on the next Enter.
    const h = mount(fakeProvider([]));
    await flush();
    await press(h, 'hello');
    await press(h, KEY.ctrlO);
    expect(h.lastFrame()).toContain('hello');
    expect(h.lastFrame()).not.toContain('helloo');
  });

  it('shows the user message and the assistant reply of the turn', async () => {
    const path = longFile();
    const h = mount(readThenAnswer(path));
    await flush();
    await runTurnWithRead(h, path);
    await waitFor(h, (f) => f.includes('read it'), 'assistant reply');
    expect(state.history.length).toBeGreaterThan(0);
  });
});

describe('input handling', () => {
  it('opens the command menu on / and closes it on Esc', async () => {
    const h = mount();
    await flush();
    h.write('/');
    await flush();
    expect(h.lastFrame()).toContain('Tab complete');

    await press(h, KEY.escape);
    expect(h.lastFrame()).not.toContain('Tab complete');
  });

  it('completes the highlighted command on Tab', async () => {
    const h = mount();
    await flush();
    h.write('/mod');
    await flush();
    await press(h, KEY.tab);
    await waitFor(h, (f) => f.includes('/model'), 'completed command');
  });

  it('moves the highlight with the arrow keys', async () => {
    const matches = filterCommands('/s');
    expect(matches.length).toBeGreaterThan(1);
    const first = defined(matches[0], 'first /s match').name;
    const second = defined(matches[1], 'second /s match').name;

    const h = mount();
    await flush();
    await press(h, '/s');
    expect(h.lastFrame()).toContain(`\u203a ${first}`);

    await press(h, KEY.down);
    expect(h.lastFrame()).toContain(`\u203a ${second}`);
    expect(h.lastFrame()).not.toContain(`\u203a ${first} `);
  });

  it('reports an unknown command instead of sending it to the model', async () => {
    const h = mount(fakeProvider([]));
    await flush();
    h.write('/definitelynotacommand');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('unknown command'), 'unknown command error');
  });

  it('queues a message typed while the agent is busy', async () => {
    const path = join(home, 'q.txt');
    writeFileSync(path, 'x');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Provider = {
      name: 'slow',
      async send() {
        await gate;
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
      },
    };
    const h = mount(slow);
    await flush();
    h.write('first');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('agent is working'), 'busy state');

    h.write('second');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('queued:'), 'queued notice');
    expect(h.lastFrame()).toContain('1 queued');

    release?.();
    await waitUntil(() => state.history.length > 0, 'turn to finish');
  });

  it('drains the rest of the queue after a queued slash command', async () => {
    // A slash command runs through runSlashCommand, which never touches
    // `busy` — there is no model turn to be busy about. The drain effect
    // used to pull one queued item per busy→idle transition and rely on the
    // dispatched item itself producing the next transition; a slash command
    // produces none, so anything queued behind one was stranded until some
    // unrelated later turn happened to flip `busy` again. Each successful
    // chat turn below appends exactly one user + one assistant message to
    // state.history, so reaching 6 entries is the proof that "third" — the
    // one queued behind the slash command — actually ran, not just that it
    // was queued (the queued notice for it would contain the word "third"
    // regardless).
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Provider = {
      name: 'slow',
      async send() {
        await gate;
        return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
      },
    };
    const h = mount(slow);
    await flush();
    h.write('first');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('agent is working'), 'busy state');

    h.write('second');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('queued: "second"'), 'second queued');

    h.write('/help');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('queued: "/help"'), 'slash command queued');

    h.write('third');
    await flush();
    await press(h, KEY.enter);
    await waitFor(h, (f) => f.includes('queued: "third"'), 'third queued');
    expect(h.lastFrame()).toContain('3 queued');

    // The gate is shared across every call to `slow.send`, so once it is
    // released here, every queued chat turn resolves as soon as it starts —
    // the test just needs the drain loop to actually reach each of them.
    release?.();
    await waitUntil(() => state.history.length >= 6, 'every queued turn to finish');
    expect(state.history.length).toBe(6);
  });
});
