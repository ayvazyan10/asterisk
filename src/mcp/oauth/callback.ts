// Loopback redirect listener for the connector consent flow.
//
// OAuth hands the authorization code back through the browser, so something
// local has to be listening. RFC 8252 says a native app should use a loopback
// redirect, and this is that: a bare node:http server bound to 127.0.0.1,
// started when a flow begins and closed the moment it ends.
//
// The port is FIXED (not ephemeral) even though RFC 8252 §7.3 tells
// authorization servers to ignore the port of a loopback redirect. Enough of
// them compare the redirect URI byte-for-byte against the one from dynamic
// registration that a per-flow random port would work for one connector and
// mysteriously fail for the next. A fixed port also means the registration
// stored in `mcp_credentials` stays valid across re-consents.
//
// Reference: https://www.rfc-editor.org/rfc/rfc8252

import { createServer } from 'node:http';
import type { Server } from 'node:http';

/** Chosen to sit next to the web panel's 4321 without colliding with it. */
export const DEFAULT_CALLBACK_PORT = 4322;

export const CALLBACK_PATH = '/callback';

/** The redirect URI Asterisk registers and listens on. */
export function callbackRedirectUrl(port = callbackPort()): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/** Port override for installs where 4322 is taken. */
export function callbackPort(): number {
  const raw = process.env['ASTERISK_OAUTH_PORT'];
  if (raw === undefined) return DEFAULT_CALLBACK_PORT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_CALLBACK_PORT;
}

export interface CallbackServer {
  readonly redirectUrl: string;
  /** Resolves with the authorization code, or rejects on error/timeout. */
  waitForCode(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
  /**
   * Closes and fails whoever is waiting, rather than leaving them to time out.
   *
   * Used when a flow is abandoned — a second Connect supersedes the first.
   * Without it the superseded waiter sits on the full consent timeout holding
   * nothing anyone wants.
   */
  abort(reason: Error): Promise<void>;
}

/**
 * The fixed callback port is taken.
 *
 * Its own type because the caller can act on it — the message names the port
 * and the override — while a bare listen error reaches the panel as an opaque
 * 500 with a correlation id, which is what this replaced.
 */
export class CallbackPortBusyError extends Error {
  constructor(readonly port: number) {
    super(
      `OAuth callback port ${port} is already in use. Close whatever is holding it, or set ASTERISK_OAUTH_PORT to a free port.`,
    );
    this.name = 'CallbackPortBusyError';
  }
}

function page(title: string, body: string): string {
  // Deliberately dependency-free and inline: this page is served once, to one
  // browser, from a socket that closes seconds later.
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;color:#111">
<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;
}

/**
 * Starts the listener.
 *
 * `expectedState` is read at request time rather than passed by value: the
 * state parameter is minted by the MCP SDK while it builds the authorization
 * URL, which happens after this server is already up.
 */
export async function startCallbackServer(opts: {
  expectedState: () => string | undefined;
  port?: number;
}): Promise<CallbackServer> {
  const port = opts.port ?? callbackPort();

  let settle: ((code: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let done = false;
  const result = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Nothing awaits this promise until waitForCode() is called, and a rejection
  // before then would be an unhandled rejection. Park a no-op handler on it.
  result.catch(() => {});

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (done) {
      // Single use. A refresh of the callback tab must not replay a code.
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Already handled', 'This authorization code was already used.'));
      return;
    }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const expected = opts.expectedState();

    // The state check is the CSRF defence: without it, anyone who can reach
    // this port could feed Asterisk a code minted for a different account.
    if (expected !== undefined && state !== expected) {
      done = true;
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        page(
          'Authorization failed',
          'State mismatch — the request was not the one Asterisk started.',
        ),
      );
      fail?.(new Error('oauth state mismatch'));
      return;
    }

    if (error !== null) {
      done = true;
      const description = url.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Authorization failed', 'You can close this tab and try again.'));
      fail?.(new Error(description ? `${error}: ${description}` : error));
      return;
    }

    if (code === null) {
      done = true;
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Authorization failed', 'No authorization code in the redirect.'));
      fail?.(new Error('no authorization code in callback'));
      return;
    }

    done = true;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Connected', 'You can close this tab and go back to Asterisk.'));
    settle?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE' ? new CallbackPortBusyError(port) : e);
    });
    // 127.0.0.1, never 0.0.0.0: this socket accepts an authorization code, and
    // it has no business being reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve();
    });
  });

  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

  return {
    redirectUrl: callbackRedirectUrl(port),
    waitForCode(timeoutMs: number): Promise<string> {
      return Promise.race([
        result,
        new Promise<string>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs,
          );
          // Do not hold the process open on the timer alone.
          timer.unref?.();
        }),
      ]);
    },
    close: closeServer,
    async abort(reason: Error): Promise<void> {
      // Marked done first so a request racing the close gets the
      // already-handled page rather than resolving a flow nobody is waiting on.
      done = true;
      fail?.(reason);
      await closeServer();
    },
  };
}
