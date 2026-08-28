// Playwright session pool. One Chromium process is shared by every session
// (cheap, just an extra OS process), but each session (each Telegram chat,
// the REPL) gets its own BrowserContext + Page. That
// way cookies / logged-in state / local storage / cache are isolated by
// user, the way they would be on different physical machines.
//
// Reference: https://playwright.dev/docs/api/class-page

import type { Browser, BrowserContext, Page } from 'playwright';

import { currentSessionId } from '../../agent/context.ts';

export interface BrowserSessionOptions {
  headless?: boolean;
  userAgent?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

interface PerSession {
  context: BrowserContext;
  page: Page;
}

interface State {
  browser: Browser | null;
  sessions: Map<string, PerSession>;
  options: BrowserSessionOptions;
}

const state: State = {
  browser: null,
  sessions: new Map(),
  options: {},
};

export function configureBrowser(opts: BrowserSessionOptions): void {
  state.options = { ...state.options, ...opts };
}

/**
 * Message for the one failure every user who never wanted a browser will hit.
 *
 * Playwright is an *optional* peer dependency — installing Asterisk does not
 * pull it in, because it drags browser drivers along with it. Without this the
 * tool reported the raw loader text ("Cannot find package 'playwright'
 * imported from …/dist/cli.js"), which reads like a broken install rather than
 * a feature nobody asked for.
 */
const PLAYWRIGHT_MISSING =
  'Browser tools require the optional `playwright` package, which is not installed. ' +
  'Install it and a browser binary:  bun add playwright && bunx playwright install chromium  ' +
  '(npm: npm install playwright && npx playwright install chromium). ' +
  'Every other Asterisk tool works without it.';

function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  return /cannot find (module|package)|failed to resolve/i.test((e as Error)?.message ?? '');
}

/**
 * Lazy-import Playwright so cold-start of the REPL stays fast for users who
 * never touch a browser tool — and so a missing install is a tool error rather
 * than an unhandled rejection.
 */
async function importPlaywright(): Promise<typeof import('playwright')> {
  try {
    return await import('playwright');
  } catch (e) {
    if (isModuleNotFound(e)) throw new Error(PLAYWRIGHT_MISSING, { cause: e });
    throw e;
  }
}

async function ensureBrowser(): Promise<Browser> {
  if (state.browser) return state.browser;
  const { chromium } = await importPlaywright();
  state.browser = await chromium.launch({ headless: state.options.headless ?? true });
  return state.browser;
}

export async function getPage(): Promise<Page> {
  const sid = currentSessionId();
  const existing = state.sessions.get(sid);
  if (existing && !existing.page.isClosed()) return existing.page;

  const browser = await ensureBrowser();
  const contextOpts: Parameters<Browser['newContext']>[0] = {};
  if (state.options.userAgent) contextOpts.userAgent = state.options.userAgent;
  if (state.options.viewportWidth && state.options.viewportHeight) {
    contextOpts.viewport = {
      width: state.options.viewportWidth,
      height: state.options.viewportHeight,
    };
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  state.sessions.set(sid, { context, page });
  return page;
}

export function isOpen(): boolean {
  return state.browser !== null;
}

/** Close the current session's context only — leaves other users' tabs alone. */
export async function closeSessionBrowser(): Promise<void> {
  const sid = currentSessionId();
  const s = state.sessions.get(sid);
  if (!s) return;
  state.sessions.delete(sid);
  try {
    await s.context.close();
  } catch {}
}

/** Close everything — used on process exit / daemon shutdown. */
export async function closeBrowser(): Promise<void> {
  for (const s of state.sessions.values()) {
    try {
      await s.context.close();
    } catch {}
  }
  state.sessions.clear();
  try {
    await state.browser?.close();
  } catch {}
  state.browser = null;
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
