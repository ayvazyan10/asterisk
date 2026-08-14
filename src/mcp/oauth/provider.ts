// OAuthClientProvider for connectors — the storage and consent half of the
// MCP SDK's OAuth client.
//
// The protocol work is the SDK's: discovery of the authorization server from
// the 401 the endpoint returns (RFC 9728 protected-resource metadata, then RFC
// 8414 server metadata), dynamic client registration (RFC 7591), PKCE, the
// code exchange and refresh. All of that lives in
// `@modelcontextprotocol/sdk/client/auth.js` and none of it is reimplemented
// here. What this module supplies is everything the SDK cannot know: where to
// persist the results, and what "send the user to a URL" means for a terminal
// program.
//
// Two modes, one code path:
//
//   interactive     — `onAuthorizationUrl` is set. The consent URL is handed
//                     to the caller, which opens a browser and waits on the
//                     loopback listener in callback.ts.
//   non-interactive — no callback. This is the agent loop connecting at
//                     startup: refreshing an expired token is fine and
//                     happens silently, but a *new* consent cannot, because
//                     there is nobody at the keyboard. It throws
//                     ConsentRequiredError so the manager can say which
//                     command fixes it rather than reporting a bare 401.
//
// Reference: https://modelcontextprotocol.io/specification/basic/authorization

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { getDb } from '../../db/index.ts';
import type { SqliteDriver } from '../../db/index.ts';
import {
  clearMcpCredentials,
  readMcpCredentials,
  writeMcpCredentials,
} from '../../db/mcp-credentials.ts';
import { callbackRedirectUrl } from './callback.ts';

/**
 * Thrown when a token is needed and only a human can produce one.
 *
 * Distinct from the SDK's UnauthorizedError on purpose: that one means "the
 * server said no", this one means "Asterisk has nothing to send and cannot ask
 * for anything here".
 */
export class ConsentRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`connector "${serverName}" is not authorized — run: /mcp connect ${serverName}`);
    this.name = 'ConsentRequiredError';
  }
}

export interface ConnectorAuthProvider extends OAuthClientProvider {
  /** The `state` value minted for the flow in progress, for the callback to check. */
  readonly issuedState: string | undefined;
}

export interface ConnectorAuthOptions {
  serverName: string;
  serverUrl: string;
  scopes?: readonly string[];
  /** Defaults to the loopback listener's URL; must match what was registered. */
  redirectUrl?: string;
  /** Presence of this callback is what makes the provider interactive. */
  onAuthorizationUrl?: (url: URL) => void;
  db?: SqliteDriver;
}

function expiryFrom(tokens: OAuthTokens): number | undefined {
  return typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined;
}

export function createConnectorAuthProvider(opts: ConnectorAuthOptions): ConnectorAuthProvider {
  const db = opts.db ?? getDb();
  const { serverName, serverUrl } = opts;
  const redirect = opts.redirectUrl ?? callbackRedirectUrl();
  const scope = (opts.scopes ?? []).join(' ');

  let issuedState: string | undefined;

  const metadata: OAuthClientMetadata = {
    client_name: 'Asterisk',
    client_uri: 'https://github.com/ayvazyan10/asterisk',
    redirect_uris: [redirect],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Public client: there is no server-side secret to protect, so the code
    // exchange is bound by PKCE instead. A "confidential" client whose secret
    // ships inside a CLI on the user's own machine is confidential in name
    // only.
    token_endpoint_auth_method: 'none',
    ...(scope ? { scope } : {}),
  };

  return {
    get redirectUrl() {
      return redirect;
    },

    get clientMetadata() {
      return metadata;
    },

    get issuedState() {
      return issuedState;
    },

    state(): string {
      issuedState = crypto.randomUUID();
      return issuedState;
    },

    clientInformation(): OAuthClientInformationMixed | undefined {
      const record = readMcpCredentials(db, serverName, serverUrl);
      return record?.clientInfo as OAuthClientInformationMixed | undefined;
    },

    saveClientInformation(info: OAuthClientInformationMixed): void {
      writeMcpCredentials(db, serverName, serverUrl, { clientInfo: info });
    },

    tokens(): OAuthTokens | undefined {
      const record = readMcpCredentials(db, serverName, serverUrl);
      return record?.tokens as OAuthTokens | undefined;
    },

    saveTokens(tokens: OAuthTokens): void {
      writeMcpCredentials(db, serverName, serverUrl, {
        tokens,
        expiresAt: expiryFrom(tokens),
        // The verifier belongs to the flow that just completed. Keeping it
        // would leave a spent secret in the database for no reason.
        codeVerifier: undefined,
      });
    },

    redirectToAuthorization(authorizationUrl: URL): void {
      if (!opts.onAuthorizationUrl) throw new ConsentRequiredError(serverName);
      opts.onAuthorizationUrl(authorizationUrl);
    },

    saveCodeVerifier(codeVerifier: string): void {
      writeMcpCredentials(db, serverName, serverUrl, { codeVerifier });
    },

    codeVerifier(): string {
      const record = readMcpCredentials(db, serverName, serverUrl);
      if (!record?.codeVerifier) throw new Error(`no PKCE verifier stored for "${serverName}"`);
      return record.codeVerifier;
    },

    invalidateCredentials(scopeToClear: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
      // 'discovery' caches nothing on our side — the SDK refetches metadata
      // per flow, so there is nothing local to drop.
      if (scopeToClear === 'discovery') return;
      clearMcpCredentials(db, serverName, scopeToClear);
    },
  };
}
