// Failure modes that only small, quantised, locally-hosted models produce.
//
// The wire shapes below are not invented. The tool-call-as-text cases were
// captured from a live llama.cpp llama-server (b1-726704a) running
// gemma-4-26b at http://127.0.0.1:8080/v1 with the tools described in the
// system prompt instead of passed as `tools`, which is what happens whenever
// the server was started without a tool-aware chat template:
//
//   <|tool_call>call:Read(path="/etc/hostname")<tool_call|>
//   ```json\n{"name": "Read", "arguments": {"path": "/etc/hostname"}}\n```
//
// The empty-completion case was captured from the same server: a reasoning
// model that spends its whole budget in `reasoning_content` answers with
// content "" and finish_reason "length".
//
// The rest — malformed JSON arguments, argument shapes that disagree with the
// schema, invented tool names, runaway repetition — are reasoned from the same
// class of model and are reproduced here as wire fixtures rather than claimed
// as live observations.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { createOpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { findRunawayRepetition } from '../src/providers/repetition.ts';
import { recoverToolCallsFromText } from '../src/providers/text-tool-calls.ts';
import {
  canonicalToolName,
  coerceToolInput,
  markMalformedArguments,
  missingRequired,
  parseToolArguments,
  suggestToolNames,
} from '../src/providers/tool-repair.ts';
import type {
  ContentBlock,
  Provider,
  ProviderResponse,
  TextBlock,
  ToolUseBlock,
} from '../src/types/messages.ts';
import { defined } from './helpers.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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

function text(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** One non-streaming JSON body from the endpoint. */
/**
 * A model listing, which the provider fetches before every chat request to
 * learn what the server is serving. Returning an empty list keeps the
 * configured model in play without the detection consuming the chat response
 * these helpers are staging.
 */
function modelsResponse(): Response {
  return new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function isModelsRequest(url: unknown): boolean {
  return String(url).endsWith('/models');
}

function respond(body: unknown): void {
  globalThis.fetch = (async (url: string) => {
    if (isModelsRequest(url)) return modelsResponse();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/** SSE frames, with a count of how many the provider actually pulled. */
function sse(frames: string[]): { pulled: () => number } {
  let i = 0;
  globalThis.fetch = (async (url: string) => {
    if (isModelsRequest(url)) return modelsResponse();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i >= frames.length) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(enc.encode(`data: ${frames[i++]}\n\n`));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { pulled: () => i };
}

function ndjson(lines: string[]): { pulled: () => number } {
  let i = 0;
  globalThis.fetch = (async (url: string) => {
    if (isModelsRequest(url)) return modelsResponse();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i >= lines.length) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(enc.encode(`${lines[i++]}\n`));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { pulled: () => i };
}

const base = { system: 'sys', messages: [], tools: [] };

// ─────────────────────────────────────────────────────────────────────────
//  1. Malformed tool-call arguments
// ─────────────────────────────────────────────────────────────────────────

describe('malformed tool arguments', () => {
  it('unwraps a markdown fence around the arguments', () => {
    expect(parseToolArguments('```json\n{"path": "/etc/hostname"}\n```', 'Read')).toEqual({
      path: '/etc/hostname',
    });
  });

  it('pulls the object out of surrounding prose', () => {
    expect(parseToolArguments('Sure! {"path": "/etc/hostname"} — here you go', 'Read')).toEqual({
      path: '/etc/hostname',
    });
  });

  it('accepts python-flavoured JSON with a trailing comma', () => {
    expect(parseToolArguments("{'path': '/etc/hostname', 'recurse': True,}", 'Read')).toEqual({
      path: '/etc/hostname',
      recurse: true,
    });
  });

  it('unwraps arguments the model stringified twice', () => {
    expect(parseToolArguments(JSON.stringify('{"path":"/etc/hostname"}'), 'Read')).toEqual({
      path: '/etc/hostname',
    });
  });

  it('does not invent an object it cannot read', () => {
    const input = parseToolArguments('path = the hostname file', 'Read');
    expect(input['__malformed_arguments']).toBe('path = the hostname file');
  });

  it('leaves a brace inside a string value alone', () => {
    expect(parseToolArguments('{"command": "echo \\"}\\" done"}', 'Bash')).toEqual({
      command: 'echo "}" done',
    });
  });

  it('repairs a fenced argument stream reassembled across SSE frames', async () => {
    sse([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"Read","arguments":"```json\\n{"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"path\\": \\"/etc/hostname\\"}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\n```"}}]}}]}',
      '{"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
      '[DONE]',
    ]);
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send({
      ...base,
      onText: () => {},
    });
    expect((res.content[0] as ToolUseBlock).input).toEqual({ path: '/etc/hostname' });
  });

  it('hands the model a correction instead of running the tool blind', async () => {
    // Before the fix the sentinel reached Read as its input, Read answered
    // "path is required", and the model had no reason to suspect its JSON.
    const provider = fakeProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: markMalformedArguments('{"path": /etc/hostname}', 'Read'),
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'fixed it' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    const result = await runAgentTurn(provider, createAgentState(), 'read it', { onToolResult });

    expect(result.reason).toBe('end-turn');
    const [, message, isError] = onToolResult.mock.calls[0] as [string, string, boolean];
    expect(isError).toBe(true);
    expect(message).toMatch(/not valid JSON/);
    // It echoes what was received and what the schema wants — both are what a
    // small model needs to produce a different second attempt.
    expect(message).toContain('{"path": /etc/hostname}');
    expect(message).toMatch(/path: string \(required\)/);
    expect(message).not.toMatch(/path is required/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  2. Tool calls emitted as text
// ─────────────────────────────────────────────────────────────────────────

describe('tool calls emitted as text', () => {
  const tools = ['Read', 'Bash', 'BrowserNavigate'];

  it('recovers the gemma marker + call-syntax form seen on llama.cpp', () => {
    const recovered = defined(
      recoverToolCallsFromText('<|tool_call>call:Read(path="/etc/hostname")<tool_call|>', tools),
    );
    expect(recovered.calls).toHaveLength(1);
    expect(recovered.calls[0]).toMatchObject({ name: 'Read', input: { path: '/etc/hostname' } });
    expect(recovered.text).toBe('');
  });

  it('recovers a namespaced call, as gemma emitted it through the agent loop', () => {
    // Verbatim from a live turn: the model invented a `filesystem:` namespace
    // that was never in the prompt.
    const recovered = defined(
      recoverToolCallsFromText(
        "<|tool_call>call:filesystem:Read(path='/etc/hostname')<tool_call|>",
        tools,
      ),
    );
    expect(recovered.calls[0]).toMatchObject({ name: 'Read', input: { path: '/etc/hostname' } });
  });

  it('recovers the fenced-JSON form seen on llama.cpp', () => {
    const recovered = defined(
      recoverToolCallsFromText(
        'I will read it.\n```json\n{"name": "Read", "arguments": {"path": "/etc/hostname"}}\n```',
        tools,
      ),
    );
    expect(recovered.calls[0]).toMatchObject({ name: 'Read', input: { path: '/etc/hostname' } });
    expect(recovered.text).toBe('I will read it.');
  });

  it('recovers the Hermes/Qwen <tool_call> form, including several in one reply', () => {
    const recovered = defined(
      recoverToolCallsFromText(
        '<tool_call>{"name": "Read", "arguments": {"path": "/a"}}</tool_call>' +
          '<tool_call>{"name": "Bash", "arguments": {"command": "ls"}}</tool_call>',
        tools,
      ),
    );
    expect(recovered.calls.map((c) => c.name)).toEqual(['Read', 'Bash']);
  });

  it('recovers the Mistral [TOOL_CALLS] form', () => {
    const recovered = defined(
      recoverToolCallsFromText(
        '[TOOL_CALLS] [{"name": "Bash", "arguments": {"command": "ls"}}]',
        tools,
      ),
    );
    expect(recovered.calls[0]).toMatchObject({ name: 'Bash', input: { command: 'ls' } });
  });

  it('recovers a bare whole-message JSON call', () => {
    const recovered = defined(
      recoverToolCallsFromText('{"tool": "Bash", "parameters": {"command": "ls"}}', tools),
    );
    expect(recovered.calls[0]).toMatchObject({ name: 'Bash', input: { command: 'ls' } });
  });

  it('ignores prose that only talks about tools', () => {
    expect(
      recoverToolCallsFromText('I could use Read on /etc/hostname, or Bash(ls) instead.', tools),
    ).toBeNull();
  });

  it('ignores a fenced example that names no real tool', () => {
    expect(
      recoverToolCallsFromText('```json\n{"name": "fetch_weather", "arguments": {}}\n```', tools),
    ).toBeNull();
  });

  it('runs the tool the model described in text', async () => {
    const provider = fakeProvider([
      {
        content: [
          {
            type: 'text',
            text: '<|tool_call>call:Bash(command="echo recovered-from-text")<tool_call|>',
          },
        ],
        // The model thinks it is finished — this is exactly why the turn used
        // to end here with the markup shown to the user.
        stopReason: 'end_turn',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const state = createAgentState();
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    const result = await runAgentTurn(provider, state, 'echo it', { onToolUse, onToolResult });

    expect(onToolUse).toHaveBeenCalledWith('Bash', { command: 'echo recovered-from-text' });
    expect(onToolResult).toHaveBeenCalledWith(
      'Bash',
      expect.stringContaining('recovered-from-text'),
      false,
    );
    expect(result.finalText).toBe('done');
    // The markup is gone from the transcript rather than being shown as prose.
    const assistant = defined(state.history[1]);
    expect(text(assistant.content)).toBe('');
    expect(assistant.content.some((b) => b.type === 'tool_use')).toBe(true);
  });

  it('does not re-read prose as calls when the model used the tool channel', async () => {
    const provider = fakeProvider([
      {
        content: [
          { type: 'text', text: 'For example: ```json\n{"name":"Bash","arguments":{}}\n```' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo real' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const onToolUse = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolUse });
    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith('Bash', { command: 'echo real' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  3. Invented and mis-spelled tool names
// ─────────────────────────────────────────────────────────────────────────

describe('tool names', () => {
  it('folds a casing or punctuation slip onto the real tool', () => {
    expect(canonicalToolName('bash', ['Bash', 'Read'])).toBe('Bash');
    expect(canonicalToolName('browser_navigate', ['BrowserNavigate'])).toBe('BrowserNavigate');
    expect(canonicalToolName('read_file', ['Read', 'Write'])).toBeNull();
  });

  it('suggests candidates for a name it cannot resolve', () => {
    expect(suggestToolNames('read_file', ['Read', 'Write', 'Bash'])).toContain('Read');
  });

  it('runs a lower-cased tool name instead of failing the call', async () => {
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo cased' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith('Bash', expect.stringContaining('cased'), false);
  });

  it('tells the model what the tool is actually called', async () => {
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/x' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolResult });
    const [, message] = onToolResult.mock.calls[0] as [string, string, boolean];
    expect(message).toMatch(/not found/);
    expect(message).toMatch(/Did you mean: .*Read/);
    expect(message).toMatch(/Available tools: /);
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  4. Arguments of the wrong shape
// ─────────────────────────────────────────────────────────────────────────

describe('argument shapes', () => {
  const readSchema = {
    type: 'object' as const,
    properties: { path: { type: 'string' }, limit: { type: 'number' } },
    required: ['path'],
  };

  it('places a bare scalar into the single required parameter', () => {
    expect(coerceToolInput({ value: '/etc/hostname' }, readSchema)).toEqual({
      path: '/etc/hostname',
    });
  });

  it('unwraps arguments nested one level too deep', () => {
    expect(coerceToolInput({ arguments: { path: '/x' } }, readSchema)).toEqual({ path: '/x' });
  });

  it('unwraps a nested wrapper the model also stringified', () => {
    expect(coerceToolInput({ parameters: '{"path": "/x"}' }, readSchema)).toEqual({ path: '/x' });
  });

  it('converts a stringified number when the schema asks for one', () => {
    expect(coerceToolInput({ path: '/x', limit: '10' }, readSchema)).toEqual({
      path: '/x',
      limit: 10,
    });
  });

  it('leaves a genuinely ambiguous shape alone rather than guessing', () => {
    const twoRequired = {
      type: 'object' as const,
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    };
    expect(coerceToolInput({ value: '/x' }, twoRequired)).toEqual({ value: '/x' });
  });

  it('counts an absent required parameter but not an empty one', () => {
    // Edit deletes text with newString: "" and Write makes an empty file with
    // content: "" — treating empty as missing would reject both.
    expect(missingRequired({}, readSchema)).toEqual(['path']);
    expect(missingRequired({ path: '' }, readSchema)).toEqual([]);
  });

  it('runs the tool after repairing a bare-scalar argument end to end', async () => {
    const provider = fakeProvider([
      {
        content: [
          // What the provider produces from arguments: '"echo shaped-ok"'.
          { type: 'tool_use', id: 't1', name: 'Bash', input: { value: 'echo shaped-ok' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith('Bash', expect.stringContaining('shaped-ok'), false);
  });

  it('runs the tool after unwrapping double-wrapped arguments end to end', async () => {
    const provider = fakeProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { arguments: { command: 'echo nested-ok' } },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolResult });
    expect(onToolResult).toHaveBeenCalledWith('Bash', expect.stringContaining('nested-ok'), false);
  });

  it('names the missing parameter instead of letting the tool guess', async () => {
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: '/etc/hostname' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolResult });
    const [, message, isError] = onToolResult.mock.calls[0] as [string, string, boolean];
    expect(isError).toBe(true);
    expect(message).toMatch(/missing required parameter "path"/);
    expect(message).toMatch(/You sent: file/);
    expect(message).toMatch(/path: string \(required\)/);
  });

  it('reads a real file once the numeric argument is coerced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asterisk-shapes-'));
    const file = join(dir, 'note.txt');
    await writeFile(file, 'first\nsecond\n');
    const provider = fakeProvider([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: file, limit: '1' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    await runAgentTurn(provider, createAgentState(), 'go', { onToolResult });
    const [, output] = onToolResult.mock.calls[0] as [string, string, boolean];
    expect(output).toContain('first');
    expect(output).not.toContain('second');
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  5. Empty and whitespace-only completions
// ─────────────────────────────────────────────────────────────────────────

describe('empty completions', () => {
  it('reports a reasoning-only completion as truncated, not as an answer', async () => {
    // Captured shape: llama.cpp, gemma-4-26b, max_tokens exhausted inside
    // reasoning_content.
    respond({
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: '', reasoning_content: 'The goal is to…' },
        },
      ],
    });
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect(res.content).toEqual([]);
    expect(res.stopReason).toBe('max_tokens');
  });

  it('drops a whitespace-only completion rather than treating it as text', async () => {
    respond({ choices: [{ finish_reason: 'stop', message: { content: '   \n  ' } }] });
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect(res.content).toEqual([]);
  });

  it('re-asks once when the very first response is empty', async () => {
    const provider = fakeProvider([
      { content: [], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'here is the answer' }], stopReason: 'end_turn' },
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'what is 2+2?');

    expect(result.finalText).toBe('here is the answer');
    const prod = state.history.find(
      (m) => m.role === 'user' && /reply was empty/i.test(text(m.content)),
    );
    expect(prod).toBeDefined();
  });

  it('says so when the empty reply was a token-limit truncation', async () => {
    const provider = fakeProvider([
      { content: [], stopReason: 'max_tokens' },
      { content: [{ type: 'text', text: '4' }], stopReason: 'end_turn' },
    ]);
    const state = createAgentState();
    await runAgentTurn(provider, state, 'what is 2+2?');
    const prod = defined(
      state.history.find((m) => m.role === 'user' && /token limit/i.test(text(m.content))),
    );
    expect(text(prod.content)).toMatch(/cut off/i);
  });

  it('never writes an assistant message with no content blocks', async () => {
    // An empty content array is a 400 from the Anthropic API, and the loop
    // persists history — so one empty turn used to poison the conversation.
    const provider = fakeProvider([
      { content: [], stopReason: 'end_turn' },
      { content: [], stopReason: 'end_turn' },
    ]);
    const state = createAgentState();
    const result = await runAgentTurn(provider, state, 'hello');
    expect(result.reason).toBe('end-turn');
    for (const message of state.history) {
      expect(message.content.length).toBeGreaterThan(0);
    }
  });

  it('gives up after one re-ask instead of looping', async () => {
    const provider = fakeProvider([
      { content: [], stopReason: 'end_turn' },
      { content: [], stopReason: 'end_turn' },
    ]);
    const result = await runAgentTurn(provider, createAgentState(), 'hello');
    expect(result.reason).toBe('end-turn');
    expect(result.finalText).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  6. Runaway repetition
// ─────────────────────────────────────────────────────────────────────────

describe('runaway repetition', () => {
  it('finds the shortest repeating unit of a degenerate tail', () => {
    const hit = defined(findRunawayRepetition(`intro. ${'ha ha ha '.repeat(400)}`));
    // Period 3; which rotation of "ha " it lands on depends on where the text
    // ends, so assert the period rather than the phase.
    expect(hit.unit).toHaveLength(3);
    expect(hit.unit.trim()).toBe('ha');
    expect(hit.start).toBeGreaterThan(0);
    expect(hit.repeats).toBeGreaterThan(100);
  });

  it('leaves a deliberately repeated passage alone', () => {
    // Periodic right to the end, which is the shape the detector looks for —
    // but three repeats over ~290 characters is a rhetorical device, not a
    // model that has come off the rails.
    const prose =
      'The agent loop drives a provider through tool-use turns until it stops asking for tools. '.repeat(
        3,
      );
    expect(findRunawayRepetition(prose)).toBeNull();
  });

  it('leaves a long code listing alone', () => {
    const code = Array.from({ length: 200 }, (_, i) => `  const value${i} = compute(${i});`).join(
      '\n',
    );
    expect(findRunawayRepetition(code)).toBeNull();
  });

  it('needs more than a few repeats before it fires', () => {
    expect(
      findRunawayRepetition('abcabcabc', { minSpan: 6, minRepeats: 4, maxUnit: 8 }),
    ).toBeNull();
  });

  it('stops pulling an OpenAI-compatible stream that has degenerated', async () => {
    const frames = Array.from(
      { length: 60 },
      () => '{"choices":[{"delta":{"content":"ha ha ha ha ha ha ha ha "}}]}',
    );
    frames.push('{"choices":[{"finish_reason":"stop","delta":{}}]}', '[DONE]');
    const stream = sse(frames);

    const res = await createOpenAiCompatibleProvider({
      model: 'm',
      repetition: { minSpan: 120, minRepeats: 4, maxUnit: 32 },
    }).send({ ...base, onText: () => {} });

    // Cut short: the connection closed instead of running to the total timeout.
    expect(stream.pulled()).toBeLessThan(frames.length);
    expect(res.stopReason).toBe('stop_sequence');
    const answer = (res.content[0] as TextBlock).text;
    expect(answer.length).toBeLessThan(400);
    expect(answer.startsWith('ha')).toBe(true);
  });

  it('refuses a tool call the model has already repeated to no effect', async () => {
    const call = (id: string): ProviderResponse => ({
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo stuck' } }],
      stopReason: 'tool_use',
    });
    const provider = fakeProvider([
      call('a'),
      call('b'),
      call('c'),
      call('d'),
      call('e'),
      call('f'),
      { content: [{ type: 'text', text: 'giving up' }], stopReason: 'end_turn' },
    ]);
    const onToolResult = vi.fn();
    const result = await runAgentTurn(provider, createAgentState(), 'go', {
      maxTurns: 20,
      onToolResult,
    });

    expect(result.finalText).toBe('giving up');
    const messages = onToolResult.mock.calls.map((c) => c[1] as string);
    expect(messages.filter((m) => /already run/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('stuck'))).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  7. Wire shapes an endpoint should not be able to crash us with
// ─────────────────────────────────────────────────────────────────────────

describe('defensive wire handling', () => {
  it('survives an endpoint that answers with content parts instead of a string', async () => {
    respond({
      choices: [
        { finish_reason: 'stop', message: { content: [{ type: 'text', text: 'part answer' }] } },
      ],
    });
    const res = await createOpenAiCompatibleProvider({ model: 'm' }).send(base);
    expect((res.content[0] as TextBlock).text).toBe('part answer');
  });
});
