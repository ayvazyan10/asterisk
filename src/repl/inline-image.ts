// Inline image rendering for terminals that support it. Writes the right
// escape sequences directly to stdout via writeSync so the bytes land
// outside of Ink's draw cycle.
//
// Protocols supported (best-effort detection):
//   - iTerm2 / WezTerm  (OSC 1337 File= ...)
//   - Kitty             (APC G ... ST chunks)
//
// Anything else (Windows Terminal, VSCode terminal, generic xterm…) returns
// false; callers should fall back to showing the file path or auto-opening
// the OS image viewer.

import { readFileSync, writeSync } from 'node:fs';

export type InlineProtocol = 'iterm2' | 'wezterm' | 'kitty' | null;

export function detectInlineProtocol(): InlineProtocol {
  const tp = process.env['TERM_PROGRAM'] ?? '';
  if (tp === 'iTerm.app') return 'iterm2';
  if (tp === 'WezTerm') return 'wezterm';
  if (process.env['KITTY_WINDOW_ID'] || process.env['TERM'] === 'xterm-kitty') return 'kitty';
  return null;
}

export function inlineImageSupported(): boolean {
  return detectInlineProtocol() !== null;
}

/** Render a PNG/JPEG into the terminal. Returns true if escape sequences
 *  were written; false if no supported protocol was detected or the file
 *  couldn't be read. */
export function renderInlineImage(path: string): boolean {
  const proto = detectInlineProtocol();
  if (!proto) return false;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return false;
  }
  const b64 = buf.toString('base64');
  const fd = process.stdout.fd;

  if (proto === 'iterm2' || proto === 'wezterm') {
    // OSC 1337 ; File = ... : <base64> BEL
    const seq = `\x1b]1337;File=inline=1;preserveAspectRatio=1:${b64}\x07\n`;
    try {
      writeSync(fd, seq);
      return true;
    } catch {
      return false;
    }
  }

  if (proto === 'kitty') {
    const CHUNK = 4096;
    try {
      for (let i = 0; i < b64.length; i += CHUNK) {
        const chunk = b64.slice(i, i + CHUNK);
        const last = i + CHUNK >= b64.length;
        const head = i === 0 ? `a=T,f=100,m=${last ? '0' : '1'}` : `m=${last ? '0' : '1'}`;
        const seq = `\x1b_G${head};${chunk}\x1b\\`;
        writeSync(fd, seq);
      }
      writeSync(fd, '\n');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** OSC 8 hyperlink — most modern terminals (Windows Terminal 1.16+,
 *  GNOME Terminal, iTerm2, WezTerm, Kitty, recent VS Code, …) make the
 *  inner text clickable. Older terminals just render the bare text. */
export function hyperlink(href: string, text: string): string {
  return `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\`;
}
