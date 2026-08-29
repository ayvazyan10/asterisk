// Whether a picture ever reaches the model, and what the user hears when it
// does not.
//
// The bug these guard against is not "images do not work" — it is a bot that
// answers a screenshot with a provider error, or with silence, or with a
// confident answer to a caption it read without the picture. The gate exists
// to turn all three into one sentence, so the sentence is asserted here
// verbatim rather than by a loose regex.
//
// The detection tiers matter as much as the refusal. `qwen3.8-27b-abliterated`
// is the model this was built against: served with an mmproj, and named in a
// way no heuristic could ever get right. If the tier ordering regresses, the
// case below is the one that breaks.

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NO_VISION_REPLY,
  VISION_DISABLED_REPLY,
  discardImages,
  intakeImage,
} from '../src/bots/image-intake.ts';
import { closeDb } from '../src/db/index.ts';
import { createFallbackProvider } from '../src/providers/fallback.ts';
import { clearDetectedModels } from '../src/providers/model-detect.ts';
import { createOpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import {
  IMAGE_SUPPORT_SETTING,
  modelIdSuggestsVision,
  providerAcceptsImages,
  resolveImageSupport,
} from '../src/providers/vision.ts';
import type { Provider, ProviderResponse } from '../src/types/messages.ts';

const BASE = 'http://127.0.0.1:8080/v1';

/** A provider that answers nothing but the capability question. */
function stubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    name: 'stub',
    async send(): Promise<ProviderResponse> {
      throw new Error('not called');
    },
    ...overrides,
  };
}

describe('the name heuristic', () => {
  // Only reached when the server reports nothing at all. Every id here is a
  // real model name; the point of the table is that adding a pattern for one
  // family cannot quietly start claiming another.
  it.each([
    'llava-v1.6-34b',
    'bakllava-1',
    'Qwen2.5-VL-7B-Instruct',
    'qwen2-vl-2b',
    'internvl2-8b',
    'MiniCPM-V-2_6',
    'minicpmv-2.5',
    'pixtral-12b-2409',
    'moondream2',
    'llama-3.2-11b-vision-instruct',
    'phi-3.5-vision-instruct',
    'idefics2-8b',
    'cogvlm2-llama3',
    'smolvlm-instruct',
    'granite-vision-3.2-2b',
    'molmo-7b-d',
    'aya-vision-8b',
    'ovis2-8b',
    'glm-4v-9b',
    'gemma-3-27b-it',
    'gemma3:4b',
  ])('recognises %s', (id) => {
    expect(modelIdSuggestsVision(id)).toBe(true);
  });

  it.each([
    'qwen3.8-27b-abliterated',
    'qwen3-8b',
    'llama-3.1-8b-instruct',
    'deepseek-r1-distill-qwen-32b',
    'mistral-7b-instruct-v0.3',
    'phi-4',
    'gemma-2-9b-it',
    'codellama-13b',
    'vllm-proxy',
    'nomic-embed-text',
    '',
    '   ',
  ])('does not claim %s', (id) => {
    expect(modelIdSuggestsVision(id)).toBe(false);
  });
});

describe('resolveImageSupport', () => {
  it('lets the user overrule everything in both directions', () => {
    // A forced answer must not consult detection at all — that is the escape
    // hatch the refusal message points people at.
    expect(resolveImageSupport({ mode: 'on', modelId: 'phi-4', detected: false })).toBe(true);
    expect(resolveImageSupport({ mode: 'off', modelId: 'llava-34b', detected: true })).toBe(false);
  });

  it('believes the server over the name, in both directions', () => {
    expect(
      resolveImageSupport({ mode: 'auto', modelId: 'qwen3.8-27b-abliterated', detected: true }),
    ).toBe(true);
    // A vision-sounding name on a server serving the text-only build.
    expect(resolveImageSupport({ mode: 'auto', modelId: 'llava-34b', detected: false })).toBe(
      false,
    );
  });

  it('falls to the name only when the server said nothing', () => {
    expect(resolveImageSupport({ mode: 'auto', modelId: 'llava-34b' })).toBe(true);
    expect(resolveImageSupport({ mode: 'auto', modelId: 'qwen3-8b' })).toBe(false);
  });
});

describe('providerAcceptsImages', () => {
  it('reads a provider that never declared the capability as a no', () => {
    // Fail closed. A backend nobody taught about images is a backend that
    // should not be sent one.
    return expect(providerAcceptsImages(stubProvider())).resolves.toBe(false);
  });

  it('treats a capability check that throws as a no, not as a turn failure', () => {
    const broken = stubProvider({
      supportsImages: async () => {
        throw new Error('server on fire');
      },
    });
    return expect(providerAcceptsImages(broken)).resolves.toBe(false);
  });

  it('passes a declared yes through', () => {
    return expect(
      providerAcceptsImages(stubProvider({ supportsImages: async () => true })),
    ).resolves.toBe(true);
  });
});

describe('a fallback chain', () => {
  const links = (...answers: (boolean | undefined)[]): Provider =>
    createFallbackProvider(
      answers.map((a, i) => ({
        provider: stubProvider({
          name: `link${i}`,
          ...(a === undefined ? {} : { supportsImages: async () => a }),
        }),
        label: `link${i}`,
      })),
    );

  it('accepts images only when every link would', async () => {
    // The message is built once and offered to whichever link answers, so a
    // chain that says yes on its head alone turns a failover into a rejection.
    await expect(providerAcceptsImages(links(true, true))).resolves.toBe(true);
    await expect(providerAcceptsImages(links(true, false))).resolves.toBe(false);
    await expect(providerAcceptsImages(links(false, true))).resolves.toBe(false);
  });

  it('counts a link that never declared the capability as a no', async () => {
    await expect(providerAcceptsImages(links(true, undefined))).resolves.toBe(false);
  });
});

describe('the openai-compatible provider asks the server', () => {
  /** The real llama.cpp body: ollama-shaped `models[]` beside OpenAI `data[]`. */
  const LLAMA_CPP_MODELS = {
    models: [
      {
        name: 'qwen3.8-27b-abliterated',
        model: 'qwen3.8-27b-abliterated',
        capabilities: ['completion', 'multimodal'],
      },
    ],
    object: 'list',
    data: [
      {
        id: 'qwen3.8-27b-abliterated',
        object: 'model',
        owned_by: 'llamacpp',
        meta: { n_ctx: 131072, n_ctx_train: 262144 },
      },
    ],
  };

  /** Answers /v1/models and /props from a table, recording what was asked. */
  function serve(routes: Record<string, unknown | { status: number; body?: unknown }>): {
    urls: () => string[];
  } {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      const entry = key === undefined ? undefined : routes[key];
      if (entry === undefined) return new Response('not found', { status: 404 });
      const shaped = entry as { status?: number; body?: unknown };
      const status = typeof shaped?.status === 'number' ? shaped.status : 200;
      const body = typeof shaped?.status === 'number' ? shaped.body : entry;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { urls: () => urls };
  }

  const provider = (imageSupport: 'auto' | 'on' | 'off' = 'auto', model = ''): Provider =>
    createOpenAiCompatibleProvider({ baseUrl: BASE, model, imageSupport });

  beforeEach(() => clearDetectedModels());
  afterEach(() => {
    vi.unstubAllGlobals();
    clearDetectedModels();
  });

  it('believes `capabilities: [multimodal]` over a name no heuristic could read', async () => {
    // The case the whole tier ordering exists for: an mmproj-backed model
    // whose id contains no "vl", no "vision" and no "llava".
    expect(modelIdSuggestsVision('qwen3.8-27b-abliterated')).toBe(false);
    const served = serve({ '/v1/models': LLAMA_CPP_MODELS });

    await expect(providerAcceptsImages(provider())).resolves.toBe(true);
    // `capabilities` answered it, so /props was never needed.
    expect(served.urls().some((u) => u.endsWith('/props'))).toBe(false);
  });

  it('reads a capabilities list without multimodal as a real no', async () => {
    serve({
      '/v1/models': {
        models: [{ name: 'phi-4', capabilities: ['completion'] }],
        data: [{ id: 'phi-4' }],
      },
    });
    await expect(providerAcceptsImages(provider())).resolves.toBe(false);
  });

  it('falls back to /props when the listing carries no capabilities', async () => {
    const served = serve({
      '/v1/models': { data: [{ id: 'qwen3.8-27b-abliterated', meta: { n_ctx: 4096 } }] },
      '/props': { modalities: { vision: true, audio: false } },
    });

    await expect(providerAcceptsImages(provider())).resolves.toBe(true);
    // /props hangs off the server root, not off the /v1 namespace.
    expect(served.urls()).toContain('http://127.0.0.1:8080/props');
  });

  it('falls to the name when neither field exists', async () => {
    serve({ '/v1/models': { data: [{ id: 'llava-v1.6-34b' }] } });
    await expect(providerAcceptsImages(provider())).resolves.toBe(true);

    clearDetectedModels();
    serve({ '/v1/models': { data: [{ id: 'qwen3-8b' }] } });
    await expect(providerAcceptsImages(provider())).resolves.toBe(false);
  });

  it.each([
    ['a /props that 404s', { '/v1/models': { data: [{ id: 'phi-4' }] } }],
    [
      'a /props that answers HTML',
      {
        '/v1/models': { data: [{ id: 'phi-4' }] },
        '/props': { status: 200, body: '<html>no</html>' },
      },
    ],
    [
      'modalities of the wrong shape',
      { '/v1/models': { data: [{ id: 'phi-4' }] }, '/props': { modalities: 'yes please' } },
    ],
    [
      'a vision flag that is not a boolean',
      { '/v1/models': { data: [{ id: 'phi-4' }] }, '/props': { modalities: { vision: 'true' } } },
    ],
    [
      'capabilities that are not an array',
      {
        '/v1/models': {
          models: [{ name: 'phi-4', capabilities: 'multimodal' }],
          data: [{ id: 'phi-4' }],
        },
      },
    ],
    ['an unreachable server', {}],
  ])('degrades quietly on %s', async (_label, routes) => {
    serve(routes as Record<string, unknown>);
    // Each of these lands on the heuristic, which refuses an id it cannot read.
    await expect(providerAcceptsImages(provider())).resolves.toBe(false);
  });

  it('never throws when the endpoint answers with nothing at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(providerAcceptsImages(provider())).resolves.toBe(false);
  });

  it('does not touch the network at all when the mode is forced', async () => {
    const served = serve({ '/v1/models': LLAMA_CPP_MODELS });
    await expect(providerAcceptsImages(provider('off'))).resolves.toBe(false);
    await expect(providerAcceptsImages(provider('on'))).resolves.toBe(true);
    expect(served.urls()).toEqual([]);
  });

  it('forces on for a server that reports a plain no', async () => {
    // The override the refusal message names has to actually win.
    serve({
      '/v1/models': { models: [{ name: 'x', capabilities: ['completion'] }], data: [{ id: 'x' }] },
    });
    await expect(providerAcceptsImages(provider('on'))).resolves.toBe(true);
  });

  it('reads the pinned model name when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(providerAcceptsImages(provider('auto', 'llava-34b'))).resolves.toBe(true);
  });
});

describe('the intake gate', () => {
  let home: string;
  let prevHome: string | undefined;
  let file: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-vision-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
    file = join(home, 'shot.png');
    await writeFile(file, 'not really a png');
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  const message = (text = 'what is wrong here?') => ({
    chatId: '1',
    userId: '7',
    text,
    timestamp: 0,
    image: { path: file },
  });

  const exists = async (p: string): Promise<boolean> =>
    stat(p).then(
      () => true,
      () => false,
    );

  it('passes a message with no image through untouched', async () => {
    const result = await intakeImage(
      { chatId: '1', userId: '7', text: 'hello', timestamp: 0 },
      stubProvider(),
    );
    expect(result).toEqual({ kind: 'accepted', text: 'hello', images: [] });
  });

  it('refuses when the model cannot see, and says so in one sentence', async () => {
    const result = await intakeImage(
      message(),
      stubProvider({ supportsImages: async () => false }),
    );

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.reply).toBe(NO_VISION_REPLY);
    // The way out has to be in the message; a refusal nobody can act on is
    // barely better than the silence it replaced.
    expect(result.reply).toContain(IMAGE_SUPPORT_SETTING);
  });

  it('deletes the picture it refused', async () => {
    expect(await exists(file)).toBe(true);
    await intakeImage(message(), stubProvider({ supportsImages: async () => false }));
    expect(await exists(file)).toBe(false);
  });

  it('refuses a provider that never declared the capability', async () => {
    const result = await intakeImage(message(), stubProvider());
    expect(result.kind).toBe('refused');
    expect(await exists(file)).toBe(false);
  });

  it('accepts when the provider can see, handing the path to the turn', async () => {
    const result = await intakeImage(message(), stubProvider({ supportsImages: async () => true }));

    expect(result).toEqual({
      kind: 'accepted',
      text: 'what is wrong here?',
      images: [file],
    });
    // Still there: the bytes are read inside the turn, so the caller owns it.
    expect(await exists(file)).toBe(true);
  });

  it('gives the agent words when the caption is empty', async () => {
    // Telegram puts a picture's text in `caption`, and most people send none.
    const result = await intakeImage(
      message('  '),
      stubProvider({ supportsImages: async () => true }),
    );
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('expected acceptance');
    expect(result.text).toBe('[the user sent an image with no caption]');
  });

  it('refuses when the user turned vision off, without asking the provider', async () => {
    const { saveConfig, loadConfig } = await import('../src/config/load.ts');
    const cfg = loadConfig().config;
    saveConfig({ ...cfg, vision: { ...cfg.vision, enabled: false } });

    let asked = false;
    const result = await intakeImage(
      message(),
      stubProvider({
        supportsImages: async () => {
          asked = true;
          return true;
        },
      }),
    );

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.reply).toBe(VISION_DISABLED_REPLY);
    expect(asked).toBe(false);
    expect(await exists(file)).toBe(false);
  });

  it('discards accepted files without complaining about ones already gone', async () => {
    await discardImages([file, join(home, 'never-existed.png')]);
    expect(await exists(file)).toBe(false);
  });
});
