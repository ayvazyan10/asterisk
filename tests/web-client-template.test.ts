// A source-text guard on the control panel's client modules.
//
// This file deliberately imports nothing from `src/web/ui`. The failure it
// exists to catch stops those modules from parsing at all, so any test that
// imports them cannot run to report it — the suite just fails during
// collection with a syntax error pointing thousands of lines from the cause.
// Reading the files as text is what keeps the diagnosis available.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CLIENT_MODULES = ['app-core.ts', 'app-views.ts'];
const OPENER = 'String.raw`';

function source(file: string): string {
  return readFileSync(new URL(`../src/web/ui/${file}`, import.meta.url), 'utf8');
}

/** Index of the backtick that actually ends the String.raw template. */
function templateEnd(src: string): number {
  const open = src.indexOf(OPENER);
  if (open === -1) throw new Error('no String.raw template');
  let i = open + OPENER.length;
  // A backslash escapes the next character — the one escape String.raw honours.
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return i;
}

describe('the client template', () => {
  it('runs to the end of the file in every client module', () => {
    // Three separate times during the shadcn work, a comment written as
    // `identifier` inside the template body closed it early and turned the
    // rest of the file into code. Naming the file and quoting the text that
    // follows the stray backtick turns a baffling parse error into an obvious
    // one. Escape it as \` if a backtick is genuinely wanted in a comment.
    for (const file of CLIENT_MODULES) {
      const src = source(file);
      const rest = src.slice(templateEnd(src), templateEnd(src) + 60).trim();
      expect(`${file} → ${rest}`).toBe(`${file} → \`;`);
    }
  });

  it('exports each module as a single template', () => {
    // Two templates in one module would make the check above inspect only the
    // first, and the guard would quietly stop covering the rest.
    for (const file of CLIENT_MODULES) {
      expect(source(file).split(OPENER)).toHaveLength(2);
    }
  });
});
