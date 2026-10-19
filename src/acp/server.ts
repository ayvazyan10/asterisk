// Agent Client Protocol server — lets an editor drive Asterisk.
//
// ACP is JSON-RPC 2.0 over newline-delimited JSON on stdio, with the editor as
// client and Asterisk as agent. Reference: https://agentclientprotocol.com
//
// This implements the documented core — `initialize`, `session/new`,
// `session/prompt`, `session/cancel` — and answers everything else with
// method-not-found, which the protocol allows: the optional methods are
// advertised through capabilities, and Asterisk advertises none of them. What
// it deliberately does NOT do is claim conformance it cannot demonstrate. The
// method names, the handshake fields, the `sessionUpdate` variants and the
// `stopReason` values below were taken from the published schema rather than
// remembered, but no ACP client has been run against this, so treat editor
// interop as unproven until someone does.
//
// The transport is kept out of here on purpose: the server takes a `send`
// callback and a `handle` method, so the whole protocol can be driven in tests
// without spawning a process or touching stdio.

import { randomUUID } from 'node:crypto';

import { type AgentState, type RunOptions, createAgentState, runAgentTurn } from '../agent/loop.ts';
import { truncate } from '../commands/text.ts';
import type { Provider } from '../types/messages.ts';
import { getVersion } from '../version.ts';

/** Highest protocol version this implementation understands. */
export const PROTOCOL_VERSION = 1;

/** The subset of stopReason values this agent can produce. */
type StopReason = 'end_turn' | 'max_turn_requests' | 'cancelled' | 'refusal';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface AcpServerOptions {
  /** Emits one outgoing JSON-RPC message. */
  send(message: JsonRpcMessage): void;
  /** Builds the provider for a session. Called per session/new. */
  createProvider(): Provider;
}

interface Session {
  id: string;
  cwd: string;
  state: AgentState;
  abort?: AbortController | undefined;
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Reads the text out of an ACP prompt, which is an array of content blocks. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const b = block as Record<string, unknown>;
      if (b['type'] === 'resource_link' && typeof b['uri'] === 'string') {
        return typeof b['name'] === 'string' ? `@${b['name']} (${b['uri']})` : `@${b['uri']}`;
      }
      return b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toolUpdates(
  update: (payload: Record<string, unknown>) => void,
): Pick<RunOptions, 'onToolUse' | 'onToolResult'> {
  const pending = new Map<string, string[]>();
  return {
    onToolUse: (name, input) => {
      const toolCallId = `${name}-${randomUUID()}`;
      const ids = pending.get(name) ?? [];
      ids.push(toolCallId);
      pending.set(name, ids);
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: name,
        status: 'in_progress',
        rawInput: input,
      });
    },
    onToolResult: (name, output, isError) => {
      const toolCallId = pending.get(name)?.shift();
      if (!toolCallId) return;
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: isError ? 'failed' : 'completed',
        // Match the 30,000-character output ceiling used by Bash and Grep.
        content: [{ type: 'content', content: { type: 'text', text: truncate(output, 30000) } }],
      });
    },
  };
}

export function createAcpServer(opts: AcpServerOptions) {
  const sessions = new Map<string, Session>();

  const reply = (id: JsonRpcMessage['id'], result: unknown): void => {
    opts.send({ jsonrpc: '2.0', id: id ?? null, result });
  };
  const fail = (id: JsonRpcMessage['id'], code: number, message: string): void => {
    opts.send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  const notify = (method: string, params: Record<string, unknown>): void => {
    opts.send({ jsonrpc: '2.0', method, params });
  };

  /** One `session/update` notification. */
  const update = (sessionId: string, payload: Record<string, unknown>): void => {
    notify('session/update', { sessionId, update: payload });
  };

  async function runPrompt(session: Session, text: string, abort: AbortController) {
    let sentMessage = false;
    const result = await runAgentTurn(opts.createProvider(), session.state, text, {
      session: { id: `acp:${session.id}`, scope: 'unknown' },
      signal: abort.signal,
      // Editors render their own streaming, so deltas go out as they arrive
      // rather than being buffered into one message at the end.
      onAssistantDelta: (delta) => {
        sentMessage = true;
        update(session.id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: delta },
        });
      },
      onAssistantThinking: (delta) => {
        update(session.id, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: delta },
        });
      },
      ...toolUpdates((payload) => update(session.id, payload)),
    });
    if (!sentMessage && result.finalText) {
      update(session.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: result.finalText },
      });
    }
    return result;
  }

  async function handlePrompt(id: JsonRpcMessage['id'], params: Record<string, unknown>) {
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
    const session = sessions.get(sessionId);
    if (!session) return fail(id, INVALID_PARAMS, `unknown sessionId: ${sessionId}`);
    if (session.abort) return fail(id, INVALID_PARAMS, 'session already has a prompt in progress');

    const text = promptText(params['prompt']);
    if (!text) return fail(id, INVALID_PARAMS, 'prompt contained no text content');

    const abort = new AbortController();
    session.abort = abort;

    try {
      const result = await runPrompt(session, text, abort);

      // The loop's terminal reasons map onto ACP's vocabulary; anything it
      // does not have a word for is reported as end_turn rather than invented.
      const stopReason: StopReason =
        result.reason === 'aborted'
          ? 'cancelled'
          : result.reason === 'max-turns'
            ? 'max_turn_requests'
            : 'end_turn';

      reply(id, { stopReason });
    } catch (e) {
      fail(id, INTERNAL_ERROR, (e as Error).message);
    } finally {
      if (session.abort === abort) session.abort = undefined;
    }
  }

  function initialize(id: JsonRpcMessage['id'], params: Record<string, unknown>): void {
    const requested = typeof params['protocolVersion'] === 'number' ? params['protocolVersion'] : 0;
    reply(id, {
      // "the protocol version the client specified if supported, or the
      // latest version supported by the agent".
      protocolVersion:
        requested > 0 && requested <= PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
      agentCapabilities: {
        // Everything optional is off, and honestly so: session/load,
        // session/resume and the rest are not implemented.
        loadSession: false,
      },
      agentInfo: { name: 'asterisk', version: getVersion() },
      authMethods: [],
    });
  }

  return {
    /** Sessions currently open. Exposed for the entrypoint's shutdown path. */
    sessionCount: (): number => sessions.size,

    async handle(frame: unknown): Promise<void> {
      if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return;
      const message = frame as JsonRpcMessage;
      const { id, method } = message;
      const params = message.params ?? {};

      // A response or an unknown notification is not ours to answer. Replying
      // to a notification (no id) is a protocol violation on its own.
      if (!method) return;

      switch (method) {
        case 'initialize':
          initialize(id, params);
          return;

        case 'session/new': {
          const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : '';
          if (!cwd) return fail(id, INVALID_PARAMS, 'cwd is required and must be absolute');
          const sessionId = randomUUID();
          sessions.set(sessionId, { id: sessionId, cwd, state: createAgentState() });
          reply(id, { sessionId });
          return;
        }

        case 'session/prompt':
          await handlePrompt(id, params);
          return;

        case 'session/cancel': {
          // A notification in the spec, so it gets no reply — only the abort.
          const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
          sessions.get(sessionId)?.abort?.abort();
          return;
        }

        default:
          // Notifications get no error response, only requests do.
          if (id === undefined || id === null) return;
          fail(id, METHOD_NOT_FOUND, `method not implemented: ${method}`);
      }
    },
  };
}
