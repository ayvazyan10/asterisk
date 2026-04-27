import { describe, expect, it } from 'vitest';

import {
  findOutputStyle,
  outputStyleToPromptSection,
  OUTPUT_STYLES,
} from '../src/output-styles/styles.ts';

describe('output styles', () => {
  it('exposes the four expected styles', () => {
    expect(OUTPUT_STYLES.map((s) => s.name)).toEqual([
      'default',
      'concise',
      'explanatory',
      'learning',
    ]);
  });

  it('findOutputStyle is case-insensitive and trimmed', () => {
    expect(findOutputStyle('Concise')?.name).toBe('concise');
    expect(findOutputStyle('  EXPLANATORY  ')?.name).toBe('explanatory');
    expect(findOutputStyle('nope')).toBeUndefined();
  });

  it('default style emits no prompt section (so it is a no-op)', () => {
    const def = findOutputStyle('default');
    expect(outputStyleToPromptSection(def)).toBe('');
  });

  it('non-default styles emit a prompt section with the name + body', () => {
    for (const name of ['concise', 'explanatory', 'learning'] as const) {
      const s = findOutputStyle(name);
      const section = outputStyleToPromptSection(s);
      expect(section).toContain(`# Output style: ${name}`);
      expect(section.length).toBeGreaterThan(50);
    }
  });

  it('outputStyleToPromptSection on undefined returns empty string', () => {
    expect(outputStyleToPromptSection(undefined)).toBe('');
  });

  it('every style has a description and a prompt (default may be empty)', () => {
    for (const s of OUTPUT_STYLES) {
      expect(s.description.length).toBeGreaterThan(10);
      if (s.name === 'default') {
        expect(s.prompt).toBe('');
      } else {
        expect(s.prompt.length).toBeGreaterThan(50);
      }
    }
  });
});
