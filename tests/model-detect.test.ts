// Detecting which model the local server is serving.
//
// The shapes here are real: `data[0].id` plus `meta.n_ctx` is what llama.cpp
// answers with, and the context window is half the point — without it
// compaction budgets against a guess.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearDetectedModels,
  detectActiveModel,
  parseModelsResponse,
} from '../src/providers/model-detect.ts';
import { createOpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';

const BASE = 'http://127.0.0.1:8080/v1';

/** Serves a models listing and counts how many times it was asked. */
function serveModels(body: unknown, status = 200): { calls: () => number; headers: Headers[] } {
  let calls = 0;
  const headers: Headers[] = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls += 1;
    headers.push(new Headers(init?.headers ?? {}));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls: () => calls, headers };
}

beforeEach(() => {
  clearDetectedModels();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearDetectedModels();
});

describe('parseModelsResponse', () => {
  it('reads the id and the window llama.cpp reports', () => {
    expect(
      parseModelsResponse({
        data: [{ id: 'gemma-4-26b', meta: { n_ctx: 262144, n_ctx_train: 262144 } }],
      }),
    ).toEqual({ id: 'gemma-4-26b', contextWindow: 262144 });
  });

  it('prefers the running window over the trained maximum', () => {
    // n_ctx is what the request will be held to; n_ctx_train is what the model
    // could do on a bigger machine.
    expect(
      parseModelsResponse({ data: [{ id: 'm', meta: { n_ctx: 8192, n_ctx_train: 131072 } }] }),
    ).toEqual({ id: 'm', contextWindow: 8192 });
  });

  it('falls back to the trained window when only that is reported', () => {
    expect(parseModelsResponse({ data: [{ id: 'm', meta: { n_ctx_train: 4096 } }] })).toEqual({
      id: 'm',
      contextWindow: 4096,
    });
  });

  it('returns an id alone when no window is reported', () => {
    expect(parseModelsResponse({ data: [{ id: 'gpt-4o-mini' }] })).toEqual({ id: 'gpt-4o-mini' });
  });

  it('rejects listings with nothing usable in them', () => {
    expect(parseModelsResponse({ data: [] })).toBeNull();
    expect(parseModelsResponse({ data: [{ meta: { n_ctx: 4096 } }] })).toBeNull();
    expect(parseModelsResponse({})).toBeNull();
    expect(parseModelsResponse(null)).toBeNull();
    expect(parseModelsResponse({ data: [{ id: '   ' }] })).toBeNull();
  });
});

describe('detectActiveModel', () => {
  it('asks the endpoint and caches the answer', async () => {
    const served = serveModels({ data: [{ id: 'gemma-4-26b', meta: { n_ctx: 262144 } }] });

    expect(await detectActiveModel(BASE)).toEqual({ id: 'gemma-4-26b', contextWindow: 262144 });
    expect(await detectActiveModel(BASE)).toEqual({ id: 'gemma-4-26b', contextWindow: 262144 });
    // Once per minute, not once per turn.
    expect(served.calls()).toBe(1);
  });

  it('re-asks when forced, which is what /doctor and /model need', async () => {
    const served = serveModels({ data: [{ id: 'a' }] });
    await detectActiveModel(BASE);
    await detectActiveModel(BASE, '', { force: true });
    expect(served.calls()).toBe(2);
  });

  it('sends the key only when there is one', async () => {
    const served = serveModels({ data: [{ id: 'a' }] });
    await detectActiveModel(BASE, 'sk-test');
    expect(served.headers[0]?.get('authorization')).toBe('Bearer sk-test');

    clearDetectedModels();
    await detectActiveModel(BASE);
    expect(served.headers[1]?.get('authorization')).toBeNull();
  });

  it('caches per endpoint, so two servers do not answer for each other', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const id = String(url).includes('8080') ? 'first' : 'second';
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
    });
    expect(await detectActiveModel(BASE)).toEqual({ id: 'first' });
    expect(await detectActiveModel('http://127.0.0.1:9090/v1')).toEqual({ id: 'second' });
  });

  it('returns null rather than throwing when the server is unreachable or unhappy', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await detectActiveModel(BASE)).toBeNull();

    clearDetectedModels();
    serveModels({ error: 'nope' }, 503);
    expect(await detectActiveModel(BASE)).toBeNull();

    clearDetectedModels();
    vi.stubGlobal('fetch', async () => new Response('<html>not json</html>', { status: 200 }));
    expect(await detectActiveModel(BASE)).toBeNull();
  });
});

describe('the provider uses what it detected', () => {
  const request = { system: 'sys', messages: [], tools: [] };

  /** Answers /models with `models`, and any chat request with a fixed reply. */
  function serve(models: unknown): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify(models), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
        { status: 200 },
      );
    });
    return { bodies };
  }

  it('names the detected model and reports the server window', async () => {
    const served = serve({ data: [{ id: 'gemma-4-26b', meta: { n_ctx: 262144 } }] });
    const provider = createOpenAiCompatibleProvider({ baseUrl: BASE, model: '' });

    // Before the first request nothing has been asked yet, so it says so.
    expect(provider.name).toBe('openai-compatible:auto');

    await provider.send(request);

    expect(served.bodies[0]?.['model']).toBe('gemma-4-26b');
    expect(provider.name).toBe('openai-compatible:gemma-4-26b');
    // The window the server was started with, not the configured guess.
    expect(provider.contextWindow).toBe(262144);
  });

  it('lets the server override a stale pinned name', async () => {
    // The user swaps the model by restarting the server; a name written into
    // the config months ago must not keep being sent.
    const served = serve({ data: [{ id: 'now-serving' }] });
    const provider = createOpenAiCompatibleProvider({ baseUrl: BASE, model: 'written-last-month' });

    await provider.send(request);
    expect(served.bodies[0]?.['model']).toBe('now-serving');
  });

  it('falls back to the configured model when detection fails', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) throw new Error('ECONNREFUSED');
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }),
        { status: 200 },
      );
    });

    const provider = createOpenAiCompatibleProvider({ baseUrl: BASE, model: 'pinned' });
    await provider.send(request);
    expect(bodies[0]?.['model']).toBe('pinned');
  });

  it('refuses with a usable message when there is no model at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const provider = createOpenAiCompatibleProvider({ baseUrl: BASE, model: '' });

    // Nothing detected, nothing pinned: the failure has to name both halves of
    // the fix rather than surfacing as an empty `model` field upstream.
    await expect(provider.send(request)).rejects.toThrow(/no model to talk to/);
  });
});
