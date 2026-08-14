// The interactive half of a connector: run the consent flow once, end to end.
//
//   1. bring up the loopback listener
//   2. ask the SDK to authorize — it discovers the authorization server,
//      registers a client if it has none, and produces a consent URL
//   3. open that URL in a browser (and always surface it, because a headless
//      box, an SSH session or WSL may have no browser to open)
//   4. take the code off the listener and exchange it
//
// Step 2 can also come back AUTHORIZED immediately: that is a stored refresh
// token still doing its job, and the browser never opens.
//
// The flow is split in two — `beginConnectorFlow` returns as soon as there is
// a URL to show, and hands back a promise for the rest. A slash command has
// exactly one chance to print something, so a version that only returned at
// the end would hold the REPL for the length of a login and then report a URL
// the user needed five minutes ago. Callers that genuinely want to block (the
// tests, and anything non-interactive) use `connectConnector`.

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { execa } from 'execa';

import { getDb } from '../../db/index.ts';
import type { SqliteDriver } from '../../db/index.ts';
import { deleteMcpCredentials } from '../../db/mcp-credentials.ts';
import { type CallbackServer, startCallbackServer } from './callback.ts';
import { createConnectorAuthProvider } from './provider.ts';

/** Five minutes: long enough to log in and pick an account, short enough to give up. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ConnectorTarget {
  name: string;
  url: string;
  scopes?: readonly string[];
}

export interface ConnectConnectorOptions {
  timeoutMs?: number;
  /** Overridable so tests never shell out. */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  db?: SqliteDriver;
}

export interface PendingConnectorFlow {
  /** 'refreshed' means stored credentials were still good and no consent is needed. */
  status: 'refreshed' | 'consent-required';
  /** The consent URL, when one is needed. Show it even if the browser opened. */
  consentUrl: string | undefined;
  browserOpened: boolean;
  /** Resolves once tokens are stored; rejects on denial, mismatch or timeout. */
  completion: Promise<void>;
}

/**
 * Hands a URL to the desktop, returning whether anything accepted it.
 *
 * Never throws and never blocks the flow: the URL is surfaced regardless, so a
 * failure here costs the user a copy-paste, not the connection.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [url]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '', url]]]
        : // Linux — but under WSL the browser lives on the Windows side, so
          // wslview/explorer.exe come before xdg-open, which usually has no
          // handler registered inside the distro.
          isWsl()
          ? [
              ['wslview', [url]],
              ['explorer.exe', [url]],
              ['xdg-open', [url]],
            ]
          : [['xdg-open', [url]]];

  for (const [command, args] of candidates) {
    try {
      await execa(command, args, { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch {
      // Try the next one. explorer.exe in particular exits non-zero even when
      // it worked, so a failure here is weak evidence either way — which is
      // exactly why the URL is always shown too.
    }
  }
  return false;
}

function isWsl(): boolean {
  return process.platform === 'linux' && (process.env['WSL_DISTRO_NAME'] ?? '') !== '';
}

/**
 * Starts the flow and returns once there is something to tell the user.
 *
 * The returned `completion` owns the listener's lifetime — it closes it on
 * every path, success or failure.
 */
export async function beginConnectorFlow(
  target: ConnectorTarget,
  options: ConnectConnectorOptions = {},
): Promise<PendingConnectorFlow> {
  const db = options.db ?? getDb();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;

  let consentUrl: URL | undefined;
  // The provider needs the listener's redirect URL, and the listener needs the
  // provider's state — so the listener starts first and reads the state
  // lazily, through a closure.
  let provider: ReturnType<typeof createConnectorAuthProvider> | undefined;
  const listener: CallbackServer = await startCallbackServer({
    expectedState: () => provider?.issuedState,
  });

  try {
    provider = createConnectorAuthProvider({
      serverName: target.name,
      serverUrl: target.url,
      ...(target.scopes ? { scopes: target.scopes } : {}),
      redirectUrl: listener.redirectUrl,
      onAuthorizationUrl: (url) => {
        consentUrl = url;
      },
      db,
    });

    const scope = (target.scopes ?? []).join(' ');
    const scopeArg = scope ? { scope } : {};
    const first = await auth(provider, { serverUrl: target.url, ...scopeArg });

    if (first === 'AUTHORIZED') {
      await listener.close();
      return {
        status: 'refreshed',
        consentUrl: undefined,
        browserOpened: false,
        completion: Promise.resolve(),
      };
    }

    if (!consentUrl) throw new Error('authorization server produced no consent URL');
    const href = consentUrl.href;
    const opener = options.openBrowser ?? openInBrowser;
    const browserOpened = await opener(href);

    const activeProvider = provider;
    const completion = (async () => {
      try {
        const code = await listener.waitForCode(timeoutMs);
        const second = await auth(activeProvider, {
          serverUrl: target.url,
          authorizationCode: code,
          ...scopeArg,
        });
        if (second !== 'AUTHORIZED') throw new Error('token exchange did not produce credentials');
      } finally {
        await listener.close();
      }
    })();

    // The caller decides when to attach its handler, and a consent screen that
    // is denied or abandoned rejects this promise minutes later. Without a
    // handler parked here that rejection is unhandled — which under Node's
    // default takes the whole daemon down over a user closing a browser tab.
    // Callers still see their own .catch()/await; this only guarantees a floor.
    completion.catch(() => {});

    return { status: 'consent-required', consentUrl: href, browserOpened, completion };
  } catch (e) {
    await listener.close();
    throw e;
  }
}

export interface ConnectConnectorResult {
  status: 'authorized' | 'refreshed';
  browserOpened: boolean;
}

/** Blocking form: begin the flow and wait for it to finish. */
export async function connectConnector(
  target: ConnectorTarget,
  options: ConnectConnectorOptions = {},
): Promise<ConnectConnectorResult> {
  const flow = await beginConnectorFlow(target, options);
  if (flow.status === 'refreshed') return { status: 'refreshed', browserOpened: false };
  await flow.completion;
  return { status: 'authorized', browserOpened: flow.browserOpened };
}

/**
 * Forgets a connector's credentials locally.
 *
 * This does NOT revoke anything upstream — the grant stays live in the
 * service's own account settings until it is removed there. Callers should say
 * so rather than implying the access is gone.
 */
export function disconnectConnector(name: string, db?: SqliteDriver): boolean {
  return deleteMcpCredentials(db ?? getDb(), name);
}
