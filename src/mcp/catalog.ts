// Bundled connector catalog — the "one click and it works" half of connectors.
//
// A connector is just an http MCP server with `auth: 'oauth'` (see
// ./oauth/), so nothing here adds capability: this file only spares the user
// from finding an endpoint URL and typing it correctly. Picking an entry
// writes the same server row the Add form writes by hand.
//
// **Every URL below was read off the vendor's own documentation on
// 2026-08-14** — `docs` is the page it came from, and re-checking it is the
// whole maintenance burden of this file. Endpoints do move: Linear's `/sse`
// became `/mcp`, and Atlassian's authv2 path is newer than the one most
// third-party lists still repeat. A stale URL is not silent — Connect fails
// on discovery with the endpoint in the message — but it is still the most
// likely thing here to rot.
//
// Requirements for an entry: a publicly documented Streamable HTTP endpoint —
// our client speaks no legacy SSE transport — plus a way in. Every entry's
// `auth` and `clientRegistration` was established by running discovery against
// the live service, not by reading a table, and the three answers a service can
// give are all represented below:
//
//   dynamic OAuth — the authorization server registers our client on the spot.
//                   Linear, Notion, Atlassian, Sentry.
//   manual OAuth  — no registration endpoint, so the user creates a client in
//                   the vendor's console and pastes the id. Google: its
//                   metadata at accounts.google.com has no
//                   `registration_endpoint` field at all.
//   token         — no usable OAuth for an unregistered client. GitHub.
//
// Google is a set of per-service endpoints (`https://<service>mcp.googleapis
// .com/mcp/v1`) sharing one authorization server, so Docs, Sheets, Slides and
// Chat exist on the same pattern and can be added through the Add form with the
// same OAuth client. Only the three people actually ask for are listed here.
//
// Their `scopes` are not decoration. The SDK resolves scope as
// "explicit ?? the resource metadata's scopes_supported ?? client metadata",
// and Google's protected-resource metadata advertises the *full* scope
// alongside the narrow ones — Drive's lists `drive` next to `drive.readonly`
// and `drive.file`. Leaving scopes empty would therefore ask the user to grant
// their entire Drive. What is listed here is what Google's own setup page says
// the server needs.
//
// Slack stays absent: it exposes no endpoint a third-party client may point at.

export interface CatalogConnector {
  /** Also the MCP server name, so it must be unique and shell-safe. */
  id: string;
  name: string;
  description: string;
  url: string;
  /**
   * 'oauth' — browser consent. See `clientRegistration` for where the client
   *           id comes from; Asterisk has none pre-registered anywhere.
   * 'token' — the user issues a token and pastes it. The last resort, for
   *           services offering no OAuth path an unregistered client can take.
   */
  auth: 'oauth' | 'token';
  /**
   * How the OAuth client comes into being, for 'oauth' entries.
   *
   * 'dynamic' (the default) — RFC 7591 registration, nothing for the user to do.
   * 'manual' — the authorization server offers no registration endpoint, so the
   *            user creates a client themselves and supplies the id and secret.
   *            The secret lives in `mcp_credentials`, never in the config.
   */
  clientRegistration?: 'dynamic' | 'manual';
  /** Where a manual client is created. */
  clientUrl?: string;
  /** What to create there, in one line. */
  clientHelp?: string;
  /** Where the user creates the token, for 'token' entries. */
  tokenUrl?: string;
  /** What kind of token, in one line. */
  tokenHelp?: string;
  /** Empty means "whatever the server treats as default", which is the norm. */
  scopes: readonly string[];
  /** Shown as a card at the top of the page rather than a row in the table. */
  popular: boolean;
  /** Where the URL above was read from. */
  docs: string;
}

export const BUNDLED_CONNECTORS: readonly CatalogConnector[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles. Read and write.',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    scopes: [],
    popular: true,
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update pages and databases.',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    scopes: [],
    popular: true,
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, issues, pull requests and code search.',
    url: 'https://api.githubcopilot.com/mcp/',
    // GitHub's authorization server does not register clients dynamically, so
    // the OAuth path is closed to a client with no pre-registered id. Its own
    // docs give a personal access token in the Authorization header as the
    // alternative, which is what 'token' does.
    auth: 'token',
    tokenUrl: 'https://github.com/settings/personal-access-tokens',
    tokenHelp: 'A fine-grained personal access token with access to the repositories you want.',
    scopes: [],
    popular: true,
    docs: 'https://github.com/github/github-mcp-server',
  },
  // Google's three, sharing one authorization server and therefore one OAuth
  // client: a client created once in the Cloud console serves all of them, as
  // long as every scope below is on its consent screen. They are separate rows
  // because they are separate MCP endpoints with separate tokens, which is
  // Google's design and not ours.
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Search and read files, and create new ones.',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    clientRegistration: 'manual',
    clientUrl: 'https://console.cloud.google.com/apis/credentials',
    clientHelp:
      'A "Web application" OAuth client in your own Google Cloud project, with the scopes below on its consent screen. Google’s Workspace MCP servers are in Developer Preview.',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    popular: true,
    docs: 'https://developers.google.com/workspace/drive/api/guides/configure-mcp-server',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read mail and compose drafts.',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    clientRegistration: 'manual',
    clientUrl: 'https://console.cloud.google.com/apis/credentials',
    clientHelp:
      'A "Web application" OAuth client in your own Google Cloud project, with the scopes below on its consent screen. Google’s Workspace MCP servers are in Developer Preview.',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    popular: true,
    docs: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Calendars, events and free/busy. Read only.',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    clientRegistration: 'manual',
    clientUrl: 'https://console.cloud.google.com/apis/credentials',
    clientHelp:
      'A "Web application" OAuth client in your own Google Cloud project, with the scopes below on its consent screen. Google’s Workspace MCP servers are in Developer Preview.',
    scopes: [
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
    ],
    popular: false,
    docs: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira, Confluence, Bitbucket and Compass.',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    auth: 'oauth',
    scopes: [],
    popular: false,
    docs: 'https://github.com/atlassian/atlassian-mcp-server',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Issues, events and release health.',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    scopes: [],
    popular: false,
    docs: 'https://mcp.sentry.dev/',
  },
];

export function findCatalogConnector(id: string): CatalogConnector | undefined {
  return BUNDLED_CONNECTORS.find((c) => c.id === id);
}
