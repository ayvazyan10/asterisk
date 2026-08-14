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
 * What to try, in order, to put a URL in front of the user.
 *
 * Pure and exported so the ordering is testable: it is a per-platform
 * judgement, not a detail, and the one that matters most cannot be exercised
 * on the machine that runs CI.
 */
export function browserCommands(
  url: string,
  platform: NodeJS.Platform,
  wsl = false,
): Array<[string, string[]]> {
  if (platform === 'darwin') return [['open', [url]]];
  if (platform === 'win32') return [['cmd', ['/c', 'start', '', url]]];
  // Linux — but under WSL the browser lives on the Windows side, so
  // wslview/explorer.exe come before xdg-open, which usually has no handler
  // registered inside the distro.
  if (!wsl) return [['xdg-open', [url]]];
  return [
    ['wslview', [url]],
    ['explorer.exe', [url]],
    ['xdg-open', [url]],
  ];
}

/** Runs one candidate. Injected so tests never shell out. */
export type CommandRunner = (command: string, args: string[]) => Promise<unknown>;

const runCommand: CommandRunner = (command, args) =>
  execa(command, args, { timeout: 5000, stdio: 'ignore' });

/**
 * Runs candidates until one does not throw.
 *
 * Takes the list rather than deriving it, so what happens on a failure is
 * separable from which commands the host offers — the list is one candidate
 * long on plain Linux and three under WSL, and a test of the fall-through that
 * read `process.platform` would pass on one machine and fail on the other.
 */
export async function tryCommands(
  candidates: ReadonlyArray<[string, string[]]>,
  run: CommandRunner,
): Promise<boolean> {
  for (const [command, args] of candidates) {
    try {
      await run(command, args);
      return true;
    } catch {
      // Try the next one. explorer.exe in particular exits non-zero even when
      // it worked, so a failure here is weak evidence either way — which is
      // exactly why the URL is always shown too.
    }
  }
  return false;
}

/**
 * Hands a URL to the desktop, returning whether anything accepted it.
 *
 * Never throws and never blocks the flow: the URL is surfaced regardless, so a
 * failure here costs the user a copy-paste, not the connection.
 */
export async function openInBrowser(
  url: string,
  run: CommandRunner = runCommand,
): Promise<boolean> {
  return tryCommands(browserCommands(url, process.platform, isWsl()), run);
}

function isWsl(): boolean {
  return process.platform === 'linux' && (process.env['WSL_DISTRO_NAME'] ?? '') !== '';
}

/**
 * The flow currently holding the callback port, if any.
 *
 * The port is fixed (see ./callback.ts), so at most one flow can be open at a
 * time — and a flow stays open for the whole consent timeout, minutes during
 * which the user is looking at somebody else's login screen. Without this,
 * pressing Connect on a second service in that window failed to bind and
 * surfaced as an opaque internal error, which is exactly what it did.
 */
let activeFlow: CallbackServer | undefined;

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

  // A newer Connect wins. The click the user just made is the one they want,
  // and the abandoned flow has nothing worth protecting — no token was issued,
  // and its consent URL can simply be requested again.
  if (activeFlow) {
    await activeFlow.abort(new Error('superseded by a newer connect'));
    activeFlow = undefined;
  }

  let consentUrl: URL | undefined;
  // The provider needs the listener's redirect URL, and the listener needs the
  // provider's state — so the listener starts first and reads the state
  // lazily, through a closure.
  let provider: ReturnType<typeof createConnectorAuthProvider> | undefined;
  const listener: CallbackServer = await startCallbackServer({
    expectedState: () => provider?.issuedState,
  });
  activeFlow = listener;

  /** Only the flow that still owns the port may release the slot. */
  const release = (): void => {
    if (activeFlow === listener) activeFlow = undefined;
  };

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
      release();
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
        release();
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
    release();
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
