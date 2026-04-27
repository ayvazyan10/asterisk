import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inferAttachmentKind } from '../src/bots/adapter.ts';
import { attachTool } from '../src/tools/attach.ts';

describe('inferAttachmentKind', () => {
  it('maps common image extensions to image', () => {
    expect(inferAttachmentKind('a.png')).toBe('image');
    expect(inferAttachmentKind('a.JPG')).toBe('image');
    expect(inferAttachmentKind('a.webp')).toBe('image');
  });

  it('maps video extensions', () => {
    expect(inferAttachmentKind('clip.mp4')).toBe('video');
    expect(inferAttachmentKind('reel.MOV')).toBe('video');
  });

  it('maps audio extensions', () => {
    expect(inferAttachmentKind('voice.mp3')).toBe('audio');
    expect(inferAttachmentKind('beep.ogg')).toBe('audio');
  });

  it('falls back to document', () => {
    expect(inferAttachmentKind('paper.pdf')).toBe('document');
    expect(inferAttachmentKind('notes.txt')).toBe('document');
    expect(inferAttachmentKind('noext')).toBe('document');
  });
});

describe('Attach tool', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'asterisk-attach-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses missing path', async () => {
    const r = await attachTool.execute({});
    expect(r.isError).toBe(true);
  });

  it('refuses non-existent file', async () => {
    const r = await attachTool.execute({ path: join(dir, 'ghost.png') });
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/file not found/);
  });

  it('attaches an existing file with auto-detected kind', async () => {
    const path = join(dir, 'shot.png');
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const r = await attachTool.execute({ path });
    expect(r.isError).toBe(false);
    expect(r.attachments).toBeDefined();
    expect(r.attachments?.[0]?.kind).toBe('image');
    expect(r.attachments?.[0]?.path).toBe(path);
  });

  it('passes through caption', async () => {
    const path = join(dir, 'doc.pdf');
    await writeFile(path, 'pdf');
    const r = await attachTool.execute({ path, caption: 'see attached' });
    expect(r.attachments?.[0]?.caption).toBe('see attached');
    expect(r.attachments?.[0]?.kind).toBe('document');
  });

  it('honours an explicit kind override', async () => {
    const path = join(dir, 'note.png');
    await writeFile(path, Buffer.from([0x89, 0x50]));
    const r = await attachTool.execute({ path, kind: 'document' });
    expect(r.attachments?.[0]?.kind).toBe('document');
  });
});
