// Inline image output. Every branch here is a guess about the terminal the
// user is sitting in front of, and guessing wrong means either a missing
// image or a screenful of raw escape bytes — so the detection table and the
// "write nothing unless supported" rule both need holding down.
//
// writeSync is mocked because the real one would spray those bytes into the
// test runner's own terminal.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as string[]);
const failNextWrite = vi.hoisted(() => ({ value: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (_fd: number, data: string) => {
      if (failNextWrite.value) throw new Error('EPIPE');
      writes.push(String(data));
      return String(data).length;
    },
  };
});

const { detectInlineProtocol, hyperlink, inlineImageSupported, renderInlineImage } = await import(
  '../src/repl/inline-image.ts'
);

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ST = `${ESC}\\`;

const TERM_VARS = ['TERM_PROGRAM', 'TERM', 'KITTY_WINDOW_ID'] as const;

let saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  saved = {};
  for (const key of TERM_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  writes.length = 0;
  failNextWrite.value = false;
  dir = mkdtempSync(join(tmpdir(), 'asterisk-inline-'));
});

afterEach(() => {
  for (const key of TERM_VARS) {
    const previous = saved[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(dir, { recursive: true, force: true });
});

function imageFile(bytes: number): string {
  const path = join(dir, 'pic.png');
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

describe('detectInlineProtocol', () => {
  it('identifies iTerm2 and WezTerm by TERM_PROGRAM', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(detectInlineProtocol()).toBe('iterm2');
    process.env['TERM_PROGRAM'] = 'WezTerm';
    expect(detectInlineProtocol()).toBe('wezterm');
  });

  it('identifies kitty by either of its markers', () => {
    process.env['KITTY_WINDOW_ID'] = '1';
    expect(detectInlineProtocol()).toBe('kitty');
    delete process.env['KITTY_WINDOW_ID'];
    process.env['TERM'] = 'xterm-kitty';
    expect(detectInlineProtocol()).toBe('kitty');
  });

  it('returns null for terminals with no inline image support', () => {
    expect(detectInlineProtocol()).toBeNull();
    for (const tp of ['Apple_Terminal', 'vscode', 'Hyper', 'tmux', '']) {
      process.env['TERM_PROGRAM'] = tp;
      expect(detectInlineProtocol()).toBeNull();
    }
  });

  it('is not fooled by a plain xterm TERM', () => {
    process.env['TERM'] = 'xterm-256color';
    expect(detectInlineProtocol()).toBeNull();
  });

  it('matches TERM_PROGRAM exactly, not loosely', () => {
    // A substring match would misfire on things like "iTerm.app-nightly" and
    // send OSC 1337 to a terminal that cannot read it.
    for (const tp of ['iterm.app', 'ITERM.APP', 'wezterm', 'not-iTerm.app']) {
      process.env['TERM_PROGRAM'] = tp;
      expect(detectInlineProtocol()).toBeNull();
    }
  });

  it('prefers TERM_PROGRAM over the kitty markers', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    process.env['KITTY_WINDOW_ID'] = '1';
    expect(detectInlineProtocol()).toBe('iterm2');
  });

  it('treats an empty KITTY_WINDOW_ID as absent', () => {
    process.env['KITTY_WINDOW_ID'] = '';
    expect(detectInlineProtocol()).toBeNull();
  });

  it('drives inlineImageSupported', () => {
    expect(inlineImageSupported()).toBe(false);
    process.env['TERM_PROGRAM'] = 'WezTerm';
    expect(inlineImageSupported()).toBe(true);
  });
});

describe('renderInlineImage', () => {
  it('writes nothing when no protocol was detected', () => {
    expect(renderInlineImage(imageFile(64))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('reports failure for an unreadable file instead of throwing', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(renderInlineImage(join(dir, 'missing.png'))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('emits one OSC 1337 sequence carrying the base64 payload on iTerm2', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    const path = imageFile(48);
    expect(renderInlineImage(path)).toBe(true);
    expect(writes).toHaveLength(1);
    const seq = writes[0] ?? '';
    expect(seq.startsWith(`${ESC}]1337;File=inline=1;preserveAspectRatio=1:`)).toBe(true);
    expect(seq.endsWith(`${BEL}\n`)).toBe(true);
    expect(seq).toContain(Buffer.alloc(48, 7).toString('base64'));
  });

  it('uses the same sequence for WezTerm', () => {
    process.env['TERM_PROGRAM'] = 'WezTerm';
    expect(renderInlineImage(imageFile(48))).toBe(true);
    expect(writes[0]).toContain('1337;File=inline=1');
  });

  it('chunks the kitty payload and flags the final chunk', () => {
    process.env['TERM'] = 'xterm-kitty';
    const path = imageFile(9000);
    expect(renderInlineImage(path)).toBe(true);

    const chunks = writes.filter((w) => w.startsWith(`${ESC}_G`));
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk announces the transmission; the rest are continuations.
    expect(chunks[0]).toContain('a=T,f=100,m=1');
    for (const mid of chunks.slice(1, -1)) expect(mid).toMatch(/_Gm=1;/);
    expect(chunks[chunks.length - 1]).toMatch(/_Gm=0;/);
    for (const chunk of chunks) expect(chunk.endsWith(ST)).toBe(true);
  });

  it('reassembles to exactly the file contents on kitty', () => {
    process.env['KITTY_WINDOW_ID'] = '3';
    const path = imageFile(9000);
    renderInlineImage(path);
    const payload = writes
      .filter((w) => w.startsWith(`${ESC}_G`))
      .map((w) => w.slice(w.indexOf(';') + 1, -ST.length))
      .join('');
    expect(payload).toBe(Buffer.alloc(9000, 7).toString('base64'));
  });

  it('keeps every kitty chunk within the 4096-char limit', () => {
    process.env['KITTY_WINDOW_ID'] = '3';
    renderInlineImage(imageFile(20_000));
    for (const chunk of writes.filter((w) => w.startsWith(`${ESC}_G`))) {
      const payload = chunk.slice(chunk.indexOf(';') + 1, -ST.length);
      expect(payload.length).toBeLessThanOrEqual(4096);
    }
  });

  it('sends a single terminating chunk for a small kitty image', () => {
    process.env['KITTY_WINDOW_ID'] = '3';
    renderInlineImage(imageFile(32));
    const chunks = writes.filter((w) => w.startsWith(`${ESC}_G`));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('a=T,f=100,m=0');
  });

  it('ends the kitty transmission with a newline so the prompt is not glued to it', () => {
    process.env['KITTY_WINDOW_ID'] = '3';
    renderInlineImage(imageFile(32));
    expect(writes[writes.length - 1]).toBe('\n');
  });

  it('returns false when the terminal write fails', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    failNextWrite.value = true;
    expect(renderInlineImage(imageFile(32))).toBe(false);
  });

  it('returns false when a kitty write fails mid-transmission', () => {
    process.env['KITTY_WINDOW_ID'] = '3';
    failNextWrite.value = true;
    expect(renderInlineImage(imageFile(9000))).toBe(false);
  });
});

describe('hyperlink', () => {
  it('wraps the label in an OSC 8 pair', () => {
    const link = hyperlink('https://example.com', 'docs');
    expect(link).toBe(`${ESC}]8;;https://example.com${ST}docs${ESC}]8;;${ST}`);
  });

  it('always closes the link so following output is not clickable', () => {
    expect(hyperlink('x', 'y').endsWith(`${ESC}]8;;${ST}`)).toBe(true);
  });

  it('keeps the visible label intact', () => {
    expect(hyperlink('https://x/y?a=b', 'click here')).toContain('click here');
  });
});
