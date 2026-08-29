// The agent used to take screenshots and learn only where it had put them.
//
// What these tests guard is mostly the ways an image can go missing without
// anyone noticing: a provider that accepts an unknown block and silently drops
// it, a file too large to send, an old screenshot crowding out the whole
// history. A picture that is quietly not delivered is worse than one that
// fails loudly — the agent describes it anyway.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { estimateTokens } from '../src/agent/compaction.ts';
import { evictOldImages, mediaTypeFor, readImageBlock } from '../src/agent/images.ts';
import { createAgentState, runAgentTurn } from '../src/agent/loop.ts';
import { estimateImageTokens } from '../src/agent/tokens.ts';
import { closeDb } from '../src/db/index.ts';
import { toOpenAiMessages } from '../src/providers/openai-compatible.ts';
import type {
  ImageBlock,
  Message,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from '../src/types/messages.ts';

// A one-pixel PNG, so the tests exercise real bytes rather than a stub.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asterisk-img-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function image(data = 'AAAA', source = '/shot.png'): ImageBlock {
  return { type: 'image', data, mediaType: 'image/png', source };
}

describe('mediaTypeFor', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a.JPG', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.webp', 'image/webp'],
    ['a.gif', 'image/gif'],
  ])('maps %s', (name, expected) => {
    expect(mediaTypeFor(name)).toBe(expected);
  });

  it('refuses formats the providers do not accept', () => {
    expect(mediaTypeFor('a.bmp')).toBeNull();
    expect(mediaTypeFor('a.txt')).toBeNull();
    expect(mediaTypeFor('noextension')).toBeNull();
  });
});

describe('readImageBlock', () => {
  it('reads a real file into base64', async () => {
    const path = join(dir, 'shot.png');
    await writeFile(path, Buffer.from(PNG_BASE64, 'base64'));

    const result = await readImageBlock(path, 1_000_000);

    expect('block' in result).toBe(true);
    if ('block' in result) {
      expect(result.block.mediaType).toBe('image/png');
      expect(result.block.data).toBe(PNG_BASE64);
      expect(result.block.source).toBe(path);
    }
  });

  it('skips a file over the size limit, and says by how much', async () => {
    const path = join(dir, 'big.png');
    await writeFile(path, Buffer.alloc(5000));

    const result = await readImageBlock(path, 1000);

    expect('skipped' in result).toBe(true);
    if ('skipped' in result) expect(result.skipped).toMatch(/over the/);
  });

  it('reports a missing file rather than throwing', async () => {
    const result = await readImageBlock(join(dir, 'nope.png'), 1_000_000);
    expect('skipped' in result).toBe(true);
  });

  it('refuses a directory', async () => {
    const result = await readImageBlock(dir, 1_000_000);
    expect('skipped' in result).toBe(true);
  });
});

describe('evictOldImages', () => {
  const history = (): Message[] => [
    { role: 'user', content: [{ type: 'text', text: 'look' }, image('A', '/one.png')] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [image('B', '/two.png')] },
    { role: 'user', content: [image('C', '/three.png')] },
  ];

  it('keeps the most recent and replaces the rest with a note', () => {
    const out = evictOldImages(history(), 1);
    const images = out.flatMap((m) => m.content.filter((b) => b.type === 'image'));

    expect(images).toHaveLength(1);
    expect((images[0] as ImageBlock).data).toBe('C');
    // Named, not silently forgotten — otherwise the model has no idea it ever
    // saw the earlier one.
    expect(JSON.stringify(out)).toContain('/one.png');
    expect(JSON.stringify(out)).toContain('was dropped');
  });

  it('leaves surrounding text intact', () => {
    const out = evictOldImages(history(), 0);
    expect(JSON.stringify(out)).toContain('look');
    expect(out.flatMap((m) => m.content.filter((b) => b.type === 'image'))).toHaveLength(0);
  });

  it('does nothing when already within the limit', () => {
    const input = history();
    expect(evictOldImages(input, 5)).toBe(input);
  });
});

describe('token accounting', () => {
  it('charges an image far more than its text neighbours', () => {
    const withImage = estimateTokens([{ role: 'user', content: [image('x'.repeat(4000))] }]);
    const withText = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
    // An image the compaction budget treats as free is how a window overflows.
    expect(withImage).toBeGreaterThan(withText * 50);
  });

  it('grows with payload size but stays capped', () => {
    expect(estimateImageTokens(400_000)).toBeGreaterThan(estimateImageTokens(4_000));
    expect(estimateImageTokens(50_000_000)).toBeLessThanOrEqual(1600);
  });
});

describe('provider mapping', () => {
  it('sends OpenAI-compatible images as a data URI part', () => {
    const out = toOpenAiMessages('', [
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, image('QUJD')] },
    ]);

    const user = out.find((m) => m.role === 'user');
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p['type'] === 'text')).toBe(true);
    const imagePart = parts.find((p) => p['type'] === 'image_url');
    expect(imagePart).toBeDefined();
    expect(JSON.stringify(imagePart)).toContain('data:image/png;base64,QUJD');
  });

  it('keeps plain text as a bare string, not a parts array', () => {
    // Only vision endpoints accept the array form, so a text-only conversation
    // must not start sending it.
    const out = toOpenAiMessages('', [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(out.find((m) => m.role === 'user')?.content).toBe('hello');
  });
});

describe('provider mapping — Anthropic', () => {
  it('nests the payload under source, as the API expects', async () => {
    const { toAnthropicContent } = await import('../src/providers/anthropic.ts');
    const [block] = toAnthropicContent([image('QUJD')]) as Array<Record<string, unknown>>;

    // Passing our flat shape through unchanged is accepted as an unknown block
    // rather than rejected, so the model simply never sees the picture.
    expect(block).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
    });
  });

  it('passes every other block through untouched', async () => {
    const { toAnthropicContent } = await import('../src/providers/anthropic.ts');
    const text = { type: 'text' as const, text: 'hi' };
    expect(toAnthropicContent([text])[0]).toBe(text);
  });
});

describe('a user message carrying images', () => {
  // The transport half of this is bots/image-intake.ts; this is the other
  // half. Before it, `runAgentTurn` took a plain string and there was no way
  // for a picture *the user sent* to reach the model at all — only a picture a
  // tool had produced. The two now share one encoder and one set of caps.
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'asterisk-user-img-'));
    prevHome = process.env['ASTERISK_HOME'];
    process.env['ASTERISK_HOME'] = home;
  });

  afterEach(async () => {
    closeDb();
    if (prevHome === undefined) delete process.env['ASTERISK_HOME'];
    else process.env['ASTERISK_HOME'] = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  /**
   * Records the request the loop built, then ends the turn.
   *
   * Copied rather than kept by reference: `messages` IS the live history, so a
   * kept reference grows an assistant turn the moment this returns and the
   * assertions end up reading the state after the turn instead of the request.
   */
  function recordingProvider(seen: ProviderRequest[]): Provider {
    return {
      name: 'fake',
      async send(req: ProviderRequest): Promise<ProviderResponse> {
        seen.push({
          ...req,
          messages: req.messages.map((m) => ({ ...m, content: [...m.content] })),
        });
        return { content: [{ type: 'text', text: 'a cat' }], stopReason: 'end_turn' };
      },
    };
  }

  async function png(name: string): Promise<string> {
    const path = join(home, name);
    await writeFile(path, Buffer.from(PNG_BASE64, 'base64'));
    return path;
  }

  it('sends them as image blocks on the user turn itself', async () => {
    const seen: ProviderRequest[] = [];
    const state = createAgentState();

    const result = await runAgentTurn(recordingProvider(seen), state, 'what is this?', {
      images: [await png('a.png')],
      summariseDropped: false,
    });

    expect(result.finalText).toBe('a cat');
    const first = seen[0]?.messages[0];
    expect(first?.role).toBe('user');
    // The caption and the picture are one turn, not a message followed by a
    // synthetic one — that is what makes "what is this?" answerable.
    expect(first?.content[0]).toEqual({ type: 'text', text: 'what is this?' });
    const images = first?.content.filter((b) => b.type === 'image') ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ type: 'image', mediaType: 'image/png', data: PNG_BASE64 });
  });

  it('changes nothing when no images are attached', async () => {
    const seen: ProviderRequest[] = [];
    await runAgentTurn(recordingProvider(seen), createAgentState(), 'hello', {
      summariseDropped: false,
    });
    expect(seen[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('leaves a note the model can read when a file cannot be attached', async () => {
    // A picture that silently fails to send is how an agent ends up
    // describing something it never received.
    const seen: ProviderRequest[] = [];
    await runAgentTurn(recordingProvider(seen), createAgentState(), 'look', {
      images: [join(home, 'gone.png')],
      summariseDropped: false,
    });

    const content = seen[0]?.messages[0]?.content ?? [];
    expect(content.some((b) => b.type === 'image')).toBe(false);
    const notes = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
    expect(notes[1]?.text).toContain('image not sent');
  });

  it('merges into a trailing user message rather than stacking two', async () => {
    // Two user turns back to back are rejected outright by the Anthropic API,
    // and an aborted turn leaves tool results — a user message — last.
    const seen: ProviderRequest[] = [];
    const state = createAgentState();
    state.history.push({ role: 'user', content: [{ type: 'text', text: 'earlier' }] });

    await runAgentTurn(recordingProvider(seen), state, 'and this', {
      images: [await png('b.png')],
      summariseDropped: false,
    });

    const messages = seen[0]?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content.filter((b) => b.type === 'image')).toHaveLength(1);
  });

  it('serialises them for an OpenAI-compatible endpoint as image_url parts', async () => {
    // The block shape is provider-neutral; this is the wire form a local
    // llama.cpp with an mmproj actually accepts.
    const seen: ProviderRequest[] = [];
    await runAgentTurn(recordingProvider(seen), createAgentState(), 'what is this?', {
      images: [await png('c.png')],
      summariseDropped: false,
    });

    const out = toOpenAiMessages('', seen[0]?.messages ?? []);
    const parts = out[0]?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
    });
  });
});
