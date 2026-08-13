// A source-text guard on every String.raw template under src/web/ui.
//
// This file deliberately imports nothing from src/web/ui. The failure it
// exists to catch stops those modules from parsing at all, so any test that
// imports them cannot run to report it — the suite fails during collection
// with a syntax error pointing far from the cause. Reading the files as text
// is what keeps the diagnosis available.
//
// The bug, four times now: a comment written with an identifier in backticks
// inside a template body. The backtick closes the template, and everything
// after it becomes code. Escape it as \` if a backtick is genuinely wanted, or
// write the word plainly.
//
// The modules are discovered rather than listed, so a new one is covered the
// day it is added instead of the day someone remembers to add it here.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const UI_DIR = new URL('../src/web/ui/', import.meta.url);
const OPENER = 'String.raw`';

function source(file: string): string {
  return readFileSync(new URL(file, UI_DIR), 'utf8');
}

const MODULES = readdirSync(UI_DIR)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => source(f).includes(OPENER))
  .sort();

interface Template {
  /** 1-based line the template opens on. */
  line: number;
  /** Text immediately after the backtick that closed it. */
  after: string;
}

/**
 * Every String.raw template in a module, paired with what follows its closing
 * backtick. A well-formed one is closed by `;` — a stray backtick inside the
 * body ends it early and leaves prose there instead.
 */
function templates(src: string): Template[] {
  const found: Template[] = [];
  let from = 0;

  for (;;) {
    const open = src.indexOf(OPENER, from);
    if (open === -1) return found;

    let i = open + OPENER.length;
    // A backslash escapes the next character — the one escape String.raw honours.
    while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;

    found.push({
      line: src.slice(0, open).split('\n').length,
      after: src.slice(i + 1, i + 50).trim(),
    });
    from = i + 1;
  }
}

describe('the String.raw templates', () => {
  it('covers every module that has one', () => {
    // Guards the discovery itself: if the glob or the filter ever stops
    // matching, the suite below would pass by testing nothing.
    expect(MODULES).toContain('app-core.ts');
    expect(MODULES).toContain('components.ts');
    expect(MODULES.length).toBeGreaterThanOrEqual(6);
  });

  it('closes each one where it was meant to close', () => {
    for (const file of MODULES) {
      for (const t of templates(source(file))) {
        // Only the first character has to be the semicolon — a module may well
        // carry more code after the template. When it is not, the offending
        // text goes into the message so the diff names the cause.
        const closed = t.after.startsWith(';');
        const actual = closed ? ';' : t.after.slice(0, 40);
        expect(`${file}:${t.line} → ${actual}`).toBe(`${file}:${t.line} → ;`);
      }
    }
  });
});
