// Lazy-loaded Playwright session. Holds a singleton browser + context + page
// for the lifetime of the Asterisk process. Browser is launched on first
// tool call; close() cleans everything up on shutdown.
//
// Reference: https://playwright.dev/docs/api/class-page

import type { Browser, BrowserContext, Page } from 'playwright';

export interface BrowserSessionOptions {
  headless?: boolean;
  userAgent?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

interface SessionState {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  options: BrowserSessionOptions;
}

const state: SessionState = {
  browser: null,
  context: null,
  page: null,
  options: {},
};

export function configureBrowser(opts: BrowserSessionOptions): void {
  state.options = { ...state.options, ...opts };
}

export async function getPage(): Promise<Page> {
  if (state.page && !state.page.isClosed()) return state.page;

  // Lazy-import Playwright so cold-start of the REPL stays fast for users
  // who never touch a browser tool.
  const { chromium } = await import('playwright');

  if (!state.browser) {
    state.browser = await chromium.launch({
      headless: state.options.headless ?? true,
    });
  }
  if (!state.context) {
    const contextOpts: Parameters<Browser['newContext']>[0] = {};
    if (state.options.userAgent) contextOpts.userAgent = state.options.userAgent;
    if (state.options.viewportWidth && state.options.viewportHeight) {
      contextOpts.viewport = {
        width: state.options.viewportWidth,
        height: state.options.viewportHeight,
      };
    }
    state.context = await state.browser.newContext(contextOpts);
  }
  state.page = await state.context.newPage();
  return state.page;
}

export function isOpen(): boolean {
  return state.browser !== null;
}

export async function closeBrowser(): Promise<void> {
  try {
    await state.context?.close();
  } catch {}
  try {
    await state.browser?.close();
  } catch {}
  state.context = null;
  state.browser = null;
  state.page = null;
}

// Best-effort cleanup on process exit so we don't leave headless chromium
// procs around after Ctrl+C or daemon stop.
let exitHooked = false;
export function hookProcessExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const handler = () => {
    void closeBrowser();
  };
  process.once('beforeExit', handler);
  process.once('SIGTERM', handler);
  process.once('SIGINT', handler);
}
