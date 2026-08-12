// Browser tools — Playwright-backed primitives the agent uses to drive a
// real Chromium instance the way a human would: navigate, click, type, read
// the page, screenshot, wait for elements.
//
// Selector grammar follows Playwright's locator API
// (https://playwright.dev/docs/locators):
//   - "#id" / ".class" / "tag[attr]"  → CSS
//   - "text=Sign in"                  → text match
//   - "role=button[name='Submit']"    → ARIA role + accessible name
//   - "xpath=//button"                → XPath

import { homedir } from 'node:os';
import { join } from 'node:path';

import { expandHome } from '../../utils/path.ts';
import { type Tool, err, ok } from '../types.ts';
import { closeSessionBrowser, getPage, hookProcessExit, isOpen } from './session.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 30_000;
const SNAPSHOT_TEXT_LIMIT = 3000;

hookProcessExit();

export const browserNavigateTool: Tool = {
  name: 'BrowserNavigate',
  description:
    'Open a URL in the shared browser (launches Chromium on first call). Default waits for DOMContentLoaded (page rendered, JS may still load) — fast and works on ad-laden sites. Pass waitUntil="networkidle" only for SPA pages where you need every fetch to settle. 30s timeout.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL to load.' },
      waitUntil: {
        type: 'string',
        description:
          '"load" | "domcontentloaded" | "networkidle" | "commit". Default "domcontentloaded".',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const url = typeof input['url'] === 'string' ? input['url'] : '';
    if (!url) return err('url is required');
    const requested = input['waitUntil'] as string | undefined;
    const waitUntil: (typeof ALLOWED_WAIT)[number] =
      requested && (ALLOWED_WAIT as readonly string[]).includes(requested)
        ? (requested as (typeof ALLOWED_WAIT)[number])
        : 'domcontentloaded';
    try {
      const page = await getPage();
      if (opts?.signal?.aborted) return err('aborted');
      try {
        await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT_MS });
      } catch (gotoError) {
        // Heavy ad/analytics sites often miss `domcontentloaded` cleanly; retry
        // with the most permissive readiness signal so we don't fail just
        // because some third-party tracker is slow.
        const msg = (gotoError as Error).message;
        if (waitUntil !== 'commit' && /(Timeout|net::ERR)/i.test(msg)) {
          await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
        } else {
          throw gotoError;
        }
      }
      const title = await page.title();
      return ok(`navigated · ${page.url()}\ntitle: ${title}`);
    } catch (e) {
      return err(`BrowserNavigate failed: ${(e as Error).message}`);
    }
  },
};

const ALLOWED_WAIT = ['load', 'domcontentloaded', 'networkidle', 'commit'] as const;

export const browserClickTool: Tool = {
  name: 'BrowserClick',
  description:
    'Click an element on the current page. Selector accepts CSS, "text=…", "role=…", or "xpath=…".',
  input_schema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Locator string.' },
      timeoutMs: { type: 'number', description: 'Optional override (default 15000).' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const selector = typeof input['selector'] === 'string' ? input['selector'] : '';
    if (!selector) return err('selector is required');
    const timeout =
      typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : DEFAULT_TIMEOUT_MS;
    try {
      const page = await getPage();
      if (opts?.signal?.aborted) return err('aborted');
      await page.locator(selector).first().click({ timeout });
      return ok(`clicked · ${selector}`);
    } catch (e) {
      return err(`BrowserClick failed: ${(e as Error).message}`);
    }
  },
};

export const browserTypeTool: Tool = {
  name: 'BrowserType',
  description:
    'Type text into an input/textarea on the current page. Set submit=true to press Enter after.',
  input_schema: {
    type: 'object',
    properties: {
      selector: { type: 'string' },
      text: { type: 'string' },
      submit: { type: 'boolean' },
      clear: { type: 'boolean', description: 'Clear existing value first (default true).' },
    },
    required: ['selector', 'text'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const selector = typeof input['selector'] === 'string' ? input['selector'] : '';
    const text = typeof input['text'] === 'string' ? input['text'] : '';
    if (!selector) return err('selector is required');
    const clear = input['clear'] !== false;
    const submit = input['submit'] === true;
    try {
      const page = await getPage();
      if (opts?.signal?.aborted) return err('aborted');
      const locator = page.locator(selector).first();
      if (clear) await locator.fill('', { timeout: DEFAULT_TIMEOUT_MS });
      await locator.type(text, { timeout: DEFAULT_TIMEOUT_MS });
      if (submit) await page.keyboard.press('Enter');
      return ok(`typed ${text.length} chars${submit ? ' + Enter' : ''} · ${selector}`);
    } catch (e) {
      return err(`BrowserType failed: ${(e as Error).message}`);
    }
  },
};

export const browserPressTool: Tool = {
  name: 'BrowserPress',
  description:
    'Send a keyboard key to the current page (e.g. Enter, Tab, Escape, ArrowDown, Control+a).',
  input_schema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  async execute(input) {
    const key = typeof input['key'] === 'string' ? input['key'] : '';
    if (!key) return err('key is required');
    try {
      const page = await getPage();
      await page.keyboard.press(key);
      return ok(`pressed · ${key}`);
    } catch (e) {
      return err(`BrowserPress failed: ${(e as Error).message}`);
    }
  },
};

export const browserSnapshotTool: Tool = {
  name: 'BrowserSnapshot',
  description:
    'Read the current page: title, URL, visible text (truncated), and a numbered list of interactive elements (buttons, links, form fields) with their accessible labels and selectors.',
  input_schema: {
    type: 'object',
    properties: {
      maxText: { type: 'number', description: 'Char cap on visible text (default 3000).' },
      maxElements: { type: 'number', description: 'Cap on interactive elements (default 60).' },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const maxText = typeof input['maxText'] === 'number' ? input['maxText'] : SNAPSHOT_TEXT_LIMIT;
    const maxElements = typeof input['maxElements'] === 'number' ? input['maxElements'] : 60;
    try {
      const page = await getPage();
      const title = await page.title();
      const url = page.url();
      const visible = await page.evaluate((cap: number) => {
        const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n');
        return text.length > cap ? `${text.slice(0, cap)}\n…[truncated]` : text;
      }, maxText);

      const interactive = await page.evaluate((cap: number) => {
        const sel =
          'a[href], button, [role="button"], [role="link"], input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
        const list = Array.from(document.querySelectorAll<HTMLElement>(sel)).slice(0, cap);
        return list.map((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') ?? tag;
          const label =
            el.getAttribute('aria-label') ??
            el.getAttribute('placeholder') ??
            (el as HTMLInputElement).value ??
            (el.textContent ?? '').trim().slice(0, 80) ??
            '';
          const id = el.id ? `#${el.id}` : '';
          const name = el.getAttribute('name');
          const nameSel = name ? `[name="${name}"]` : '';
          const hint = id || nameSel || `${tag}:nth-of-type(${siblingIndex(el)})`;
          return { role, label: label.replace(/\s+/g, ' ').trim(), selector: hint };
        });

        function siblingIndex(el: Element): number {
          let i = 1;
          let sib = el.previousElementSibling;
          while (sib) {
            if (sib.tagName === el.tagName) i++;
            sib = sib.previousElementSibling;
          }
          return i;
        }
      }, maxElements);

      const elementLines = interactive.map(
        (e: { role: string; label: string; selector: string }, i: number) =>
          `  [${i + 1}] ${e.role.padEnd(8)} ${e.label || '(unlabeled)'}  ${e.selector}`,
      );

      const lines = [
        `URL    ${url}`,
        `Title  ${title}`,
        '',
        `--- visible text (${visible.length} chars) ---`,
        visible,
        '',
        `--- interactive elements (${interactive.length}) ---`,
        ...elementLines,
      ];
      return ok(lines.join('\n'));
    } catch (e) {
      return err(`BrowserSnapshot failed: ${(e as Error).message}`);
    }
  },
};

export const browserScreenshotTool: Tool = {
  name: 'BrowserScreenshot',
  description:
    'Save a PNG screenshot of the current page. **Prefer leaving `path` unset** — Asterisk will save to ~/.asterisk/screenshots/<timestamp>.png and the REPL will render it inline (or hyperlink) automatically. Only set `path` if the user explicitly requested a specific location. A bare filename like "out.png" is taken relative to ~/.asterisk/screenshots/. Use `~/` for home, `/abs/` for an absolute path, or `./rel/` for cwd-relative.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Optional. Bare filename → ~/.asterisk/screenshots/<name>. ~/path → home. /abs/path → absolute. ./rel → cwd. Leave unset for default.',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture the full scrollable page (default true).',
      },
      open: {
        type: 'boolean',
        description:
          'After saving, open in the OS image viewer (default false). Useful on WSL/Windows.',
      },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const fullPage = input['fullPage'] !== false;
    const screenshotsRoot = join(
      process.env['ASTERISK_HOME'] ?? join(homedir(), '.asterisk'),
      'screenshots',
    );
    const raw = typeof input['path'] === 'string' ? input['path'].trim() : '';
    let requestedPath: string;
    if (!raw) {
      requestedPath = join(
        screenshotsRoot,
        `${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      );
    } else if (raw.startsWith('~')) {
      requestedPath = expandHome(raw);
    } else if (raw.startsWith('/')) {
      requestedPath = raw;
    } else if (raw.startsWith('./') || raw.startsWith('../')) {
      requestedPath = raw;
    } else if (!raw.includes('/')) {
      // Bare filename → keep it under the default screenshots directory.
      requestedPath = join(screenshotsRoot, raw);
    } else {
      requestedPath = raw;
    }
    const { resolve, dirname } = await import('node:path');
    const target = resolve(requestedPath);
    try {
      const page = await getPage();
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage });
      let openMessage = '';
      if (input['open'] === true) {
        try {
          await openWithSystemViewer(target);
          openMessage = '\nopened in system viewer';
        } catch (e) {
          openMessage = `\nopen failed: ${(e as Error).message}`;
        }
      }
      // The attachment is what lets the *agent* see the shot: the loop turns
      // image attachments into content blocks the model receives. It is also
      // what the REPL renders inline, so the path is reported once, here.
      return {
        ...ok(`screenshot saved · ${target}\nfile://${target}${openMessage}`),
        attachments: [{ kind: 'image' as const, path: target }],
      };
    } catch (e) {
      return err(`BrowserScreenshot failed: ${(e as Error).message}`);
    }
  },
};

export const browserWaitTool: Tool = {
  name: 'BrowserWait',
  description:
    'Wait for an element to appear, the network to go idle, or a fixed delay. Specify exactly one of: selector, networkIdle, or timeoutMs.',
  input_schema: {
    type: 'object',
    properties: {
      selector: { type: 'string' },
      networkIdle: { type: 'boolean' },
      timeoutMs: { type: 'number' },
    },
    additionalProperties: false,
  },
  async execute(input) {
    const selector = typeof input['selector'] === 'string' ? input['selector'] : '';
    const networkIdle = input['networkIdle'] === true;
    const timeoutMs = typeof input['timeoutMs'] === 'number' ? input['timeoutMs'] : 0;
    // Validate before touching the browser — launching Chromium just to fail
    // with a usage error wastes time and confuses CI environments where the
    // browser isn't installed.
    if (!selector && !networkIdle && timeoutMs <= 0) {
      return err('specify selector, networkIdle, or timeoutMs');
    }
    try {
      const page = await getPage();
      if (selector) {
        await page.locator(selector).first().waitFor({ timeout: DEFAULT_TIMEOUT_MS });
        return ok(`appeared · ${selector}`);
      }
      if (networkIdle) {
        await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT_MS });
        return ok('network idle');
      }
      // timeoutMs > 0 — fixed delay.
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 60_000)));
      return ok(`waited ${timeoutMs}ms`);
    } catch (e) {
      return err(`BrowserWait failed: ${(e as Error).message}`);
    }
  },
};

export const browserCloseTool: Tool = {
  name: 'BrowserClose',
  description:
    'Close the shared browser session. Useful when the user is done with browsing or to free memory.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    if (!isOpen()) return ok('browser not open');
    // Close only this session's context — other users keep their tabs.
    await closeSessionBrowser();
    return ok('browser closed');
  },
};

async function openWithSystemViewer(path: string): Promise<void> {
  const { execa } = await import('execa');
  const isWsl = !!process.env['WSL_DISTRO_NAME'] || !!process.env['WSL_INTEROP'];
  const platform = process.platform;
  const candidates: { cmd: string; args: string[] }[] =
    platform === 'darwin'
      ? [{ cmd: 'open', args: [path] }]
      : (platform as string) === 'win32'
        ? [{ cmd: 'cmd.exe', args: ['/c', 'start', '', path] }]
        : isWsl
          ? [
              { cmd: 'wslview', args: [path] },
              { cmd: 'explorer.exe', args: [path] },
              { cmd: 'xdg-open', args: [path] },
            ]
          : [{ cmd: 'xdg-open', args: [path] }];
  let lastError: Error | null = null;
  for (const { cmd, args } of candidates) {
    try {
      await execa(cmd, args, { reject: false, stdio: 'ignore' });
      return;
    } catch (e) {
      lastError = e as Error;
    }
  }
  if (lastError) throw lastError;
}

export const BROWSER_TOOLS = [
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserPressTool,
  browserSnapshotTool,
  browserScreenshotTool,
  browserWaitTool,
  browserCloseTool,
];
