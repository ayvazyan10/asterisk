// Browser tools — smoke-test the input schemas and that each tool exposes a
// sensible name + description. We don't spin up a real browser here; doing
// so requires the chromium binary to be installed and would slow the test
// suite considerably. Live browser behaviour is exercised via REPL/manual
// runs instead.

import { describe, expect, it } from 'vitest';

import {
  BROWSER_TOOLS,
  browserClickTool,
  browserCloseTool,
  browserNavigateTool,
  browserPressTool,
  browserScreenshotTool,
  browserSnapshotTool,
  browserTypeTool,
  browserWaitTool,
} from '../src/tools/browser/tools.ts';

describe('browser tools', () => {
  it('exports eight tools, all with object input_schema', () => {
    expect(BROWSER_TOOLS).toHaveLength(8);
    for (const tool of BROWSER_TOOLS) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.name).toMatch(/^Browser/);
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('BrowserNavigate requires url', async () => {
    const r = await browserNavigateTool.execute({});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/url is required/);
  });

  it('BrowserClick requires selector', async () => {
    const r = await browserClickTool.execute({});
    expect(r.isError).toBe(true);
  });

  it('BrowserType requires selector', async () => {
    const r = await browserTypeTool.execute({ text: 'hello' });
    expect(r.isError).toBe(true);
  });

  it('BrowserPress requires key', async () => {
    const r = await browserPressTool.execute({});
    expect(r.isError).toBe(true);
  });

  it('BrowserWait requires at least one mode', async () => {
    const r = await browserWaitTool.execute({});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/specify selector, networkIdle, or timeoutMs/);
  });

  it('BrowserScreenshot exposes a path-overridable schema', () => {
    expect(browserScreenshotTool.input_schema.properties).toHaveProperty('path');
    expect(browserScreenshotTool.input_schema.properties).toHaveProperty('fullPage');
  });

  it('BrowserSnapshot has caps', () => {
    expect(browserSnapshotTool.input_schema.properties).toHaveProperty('maxText');
    expect(browserSnapshotTool.input_schema.properties).toHaveProperty('maxElements');
  });

  it('BrowserClose has no required input', () => {
    expect(browserCloseTool.input_schema.required ?? []).toEqual([]);
  });
});
