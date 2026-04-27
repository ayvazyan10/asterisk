import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { expandHome } from '../src/utils/path.ts';

describe('expandHome', () => {
  it('returns plain paths unchanged', () => {
    expect(expandHome('/var/log')).toBe('/var/log');
    expect(expandHome('relative/dir')).toBe('relative/dir');
    expect(expandHome('')).toBe('');
  });

  it('expands a bare ~ to homedir', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands ~/foo to <homedir>/foo', () => {
    expect(expandHome('~/screenshots/x.png')).toBe(join(homedir(), 'screenshots/x.png'));
  });

  it('does NOT expand ~user (other-user shorthand) — stays literal', () => {
    expect(expandHome('~bob/file')).toBe('~bob/file');
  });
});
