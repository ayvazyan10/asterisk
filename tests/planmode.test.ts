import { afterEach, describe, expect, it } from 'vitest';

import {
  enterPlanModeTool,
  exitPlanModeTool,
  isPlanMode,
  setPlanMode,
} from '../src/tools/planmode.ts';
import { listTools } from '../src/tools/registry.ts';

describe('Plan Mode', () => {
  afterEach(() => setPlanMode(false));

  it('toggles via Enter/Exit tools', async () => {
    expect(isPlanMode()).toBe(false);
    const a = await enterPlanModeTool.execute({ reason: 'investigate' });
    expect(a.isError).toBe(false);
    expect(isPlanMode()).toBe(true);
    const b = await exitPlanModeTool.execute({});
    expect(b.isError).toBe(false);
    expect(isPlanMode()).toBe(false);
  });

  it('listTools hides write/mutate tools while active', () => {
    const before = listTools().map((t) => t.name);
    expect(before).toContain('Bash');
    expect(before).toContain('Write');

    setPlanMode(true);
    const during = listTools().map((t) => t.name);
    expect(during).not.toContain('Bash');
    expect(during).not.toContain('Write');
    expect(during).not.toContain('Edit');
    expect(during).not.toContain('BrowserClick');
    expect(during).toContain('Read');
    expect(during).toContain('Grep');
    expect(during).toContain('WebFetch');
    expect(during).toContain('Agent');
  });
});
