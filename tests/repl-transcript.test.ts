// Transcript policy: what the REPL shows inline, what it hides behind a
// collapse hint, and what Ctrl+O reveals. These are the rules that decide
// whether a user ever sees a tool's output, so they are worth pinning.

import { describe, expect, it } from 'vitest';

import {
  type Entry,
  expandLastCollapsed,
  formatArgs,
  parseKeyValue,
  renderCollapseHint,
  summariseToolResult,
  summariseToolUse,
  truncate,
} from '../src/repl/transcript.ts';

describe('truncate', () => {
  it('leaves text at or under the limit alone', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('', 5)).toBe('');
  });

  it('clips and reports how much was dropped', () => {
    expect(truncate('abcdef', 3)).toBe('abc…[+3 chars]');
  });

  it('never returns a longer string than the input for large limits', () => {
    const text = 'x'.repeat(50);
    expect(truncate(text, 100)).toBe(text);
  });
});

describe('formatArgs', () => {
  it('renders tool input as JSON', () => {
    expect(formatArgs({ command: 'ls' })).toBe('{"command":"ls"}');
  });

  it('clips oversized argument blobs', () => {
    const out = formatArgs({ blob: 'y'.repeat(500) });
    expect(out).toContain('…[+');
    // 120 chars of JSON plus the "…[+N chars]" marker.
    expect(out.slice(0, 120)).not.toContain('…');
    expect(out.length).toBeLessThan(150);
  });
});

describe('summariseToolUse', () => {
  it('keeps a short call fully inline with nothing hidden', () => {
    const s = summariseToolUse('Bash', { command: 'echo hi' });
    expect(s.text).toBe('Bash({"command":"echo hi"})');
    // No fullText → the renderer draws no "Ctrl+O" hint, because there is
    // genuinely nothing more to show.
    expect(s.fullText).toBeUndefined();
  });

  it('collapses a long call and keeps the longer form for expansion', () => {
    const s = summariseToolUse('Read', { file_path: `/tmp/${'y'.repeat(300)}` });
    expect(s.fullText).toBeDefined();
    expect(s.text.length).toBeLessThan((s.fullText ?? '').length);
    expect(s.text.startsWith('Read({')).toBe(true);
  });

  it('gives the working indicator a shorter line than the transcript', () => {
    const s = summariseToolUse('Read', { file_path: `/tmp/${'y'.repeat(300)}` });
    expect(s.status.length).toBeLessThan(s.text.length);
  });

  it('names the tool first so the transcript scans vertically', () => {
    for (const name of ['Bash', 'Edit', 'BrowserNavigate']) {
      expect(summariseToolUse(name, { a: 1 }).text.startsWith(`${name}(`)).toBe(true);
    }
  });
});

describe('summariseToolResult', () => {
  it('shows a short single-line result verbatim', () => {
    const s = summariseToolResult('Bash', 'ok', false);
    expect(s.text).toBe('Bash → ok');
    expect(s.fullText).toBeUndefined();
    expect(s.kind).toBe('tool-result');
  });

  it('collapses multi-line output even when it is short', () => {
    const s = summariseToolResult('Read', 'line one\nline two', false);
    expect(s.text).toBe('Read → line one');
    expect(s.fullText).toBe('Read →\nline one\nline two');
  });

  it('collapses a long single line', () => {
    const s = summariseToolResult('Grep', 'z'.repeat(500), false);
    expect(s.fullText).toContain('z'.repeat(500));
    expect(s.text.length).toBeLessThan(250);
  });

  it('keeps the full payload retrievable, not just a preview', () => {
    const output = Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n');
    const s = summariseToolResult('Read', output, false);
    expect(s.fullText).toContain('row 39');
  });

  it('marks failures as errors so they render red', () => {
    expect(summariseToolResult('Bash', 'command not found', true).kind).toBe('error');
    expect(summariseToolResult('Bash', 'fine', false).kind).toBe('tool-result');
  });

  it('handles empty output without inventing a collapse', () => {
    const s = summariseToolResult('Bash', '', false);
    expect(s.text).toBe('Bash → ');
    expect(s.fullText).toBeUndefined();
  });
});

describe('renderCollapseHint', () => {
  it('counts hidden lines when the payload is multi-line', () => {
    expect(renderCollapseHint('a', 'a\nb\nc\nd')).toBe('[+3 more lines · Ctrl+O to expand]');
  });

  it('falls back to hidden characters when the line count matches', () => {
    expect(renderCollapseHint('ab', 'abcdef')).toBe('[+4 more chars · Ctrl+O to expand]');
  });

  it('never reports a negative count', () => {
    expect(renderCollapseHint('a\nb\nc', 'a')).toContain('more chars');
  });
});

const entry = (id: string, text: string, fullText?: string): Entry =>
  fullText === undefined
    ? { id, kind: 'tool-result', text }
    : { id, kind: 'tool-result', text, fullText };

describe('expandLastCollapsed (Ctrl+O)', () => {
  it('appends an expanded copy of the most recent collapsed entry', () => {
    const before = [entry('1', 'Read → a', 'Read →\na\nb\nc')];
    const after = expandLastCollapsed(before, 111);
    expect(after).toHaveLength(2);
    expect(after[1]?.kind).toBe('system');
    expect(after[1]?.text).toContain('expanded: Read → a');
    expect(after[1]?.text).toContain('a\nb\nc');
  });

  it('picks the LAST collapsed entry, not the first', () => {
    const before = [
      entry('1', 'first', 'FIRST-FULL'),
      entry('2', 'plain'),
      entry('3', 'third', 'THIRD-FULL'),
    ];
    const after = expandLastCollapsed(before, 1);
    expect(after[3]?.text).toContain('THIRD-FULL');
    expect(after[3]?.text).not.toContain('FIRST-FULL');
  });

  it('skips entries that have nothing hidden', () => {
    const before = [
      entry('1', 'collapsed', 'FULL'),
      entry('2', 'plain one'),
      entry('3', 'plain 2'),
    ];
    const after = expandLastCollapsed(before, 1);
    expect(after[3]?.text).toContain('FULL');
  });

  it('returns the same array instance when nothing is collapsed', () => {
    // Identity matters: a useState setter that returns the previous value
    // skips the re-render entirely, which is the point of the append-only
    // design under <Static>.
    const before = [entry('1', 'plain')];
    expect(expandLastCollapsed(before, 1)).toBe(before);
  });

  it('is a no-op on an empty transcript', () => {
    const before: Entry[] = [];
    expect(expandLastCollapsed(before, 1)).toBe(before);
  });

  it('does not mutate the entries it was given', () => {
    const before = [entry('1', 'x', 'XFULL')];
    const snapshot = JSON.parse(JSON.stringify(before));
    expandLastCollapsed(before, 1);
    expect(before).toEqual(snapshot);
  });

  it('gives the appended entry an id no earlier entry holds', () => {
    const before = [entry('0_1', 'x', 'XFULL')];
    const after = expandLastCollapsed(before, 999);
    const ids = after.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('can be applied repeatedly without losing the original', () => {
    let entries: Entry[] = [entry('1', 'x', 'XFULL')];
    entries = expandLastCollapsed(entries, 1);
    entries = expandLastCollapsed(entries, 2);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.text).toBe('x');
  });
});

describe('parseKeyValue', () => {
  it('splits a two-space-aligned label/value pair', () => {
    const kv = parseKeyValue('Provider   ollama');
    expect(kv?.value).toBe('ollama');
    expect(kv?.label.trim()).toBe('Provider');
  });

  it('reassembles into the original line', () => {
    // The panel prints label, gap and value as three <Text> nodes in a row.
    // If the pieces did not concatenate back to the source line, the rendered
    // column alignment would silently drift.
    for (const line of ['Provider   ollama', 'model: gpt-4', 'Home dir    /tmp/x']) {
      const kv = parseKeyValue(line);
      expect(kv).not.toBeNull();
      expect(`${kv?.label}${kv?.gap}${kv?.value}`).toBe(line);
    }
  });

  it('accepts a single space after a glued colon', () => {
    expect(parseKeyValue('model: gpt-4')?.label).toBe('model:');
  });

  it('rejects prose, indented lines, and over-long labels', () => {
    expect(parseKeyValue('just a sentence here')).toBeNull();
    expect(parseKeyValue('  indented   value')).toBeNull();
    expect(parseKeyValue('AVeryLongLabelIndeedYesss   v')).toBeNull();
    expect(parseKeyValue('')).toBeNull();
    expect(parseKeyValue('123   numeric-label')).toBeNull();
  });

  it('rejects a label with no value', () => {
    expect(parseKeyValue('Provider   ')).toBeNull();
  });
});
