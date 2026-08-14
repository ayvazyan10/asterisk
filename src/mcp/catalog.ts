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
// What is deliberately absent, and why it is not an oversight: Gmail, Google
// Drive, Google Calendar and Slack. Those are the entries people ask for first
// because Claude's own connector list shows them, but Claude reaches them
// through integrations Anthropic operates, not through a public endpoint a
// third-party client may point at. Supporting them means registering an OAuth
// client with each vendor and hosting a server per service — real work with a
// per-vendor approval process, not a row in this table. Listing them with a
// guessed URL would produce a button that always fails.
//
// Requirements for an entry: a publicly documented Streamable HTTP endpoint —
// our client speaks no legacy SSE transport — plus a way in. Every entry's
// `auth` was established by actually running the flow against it, not by
// reading a table: four register clients dynamically and take the browser
// path, and GitHub answered "does not support dynamic client registration",
// which is what put it on the token path instead. Anything else belongs in the
// Add form, where the user supplies what they know.

export interface CatalogConnector {
  /** Also the MCP server name, so it must be unique and shell-safe. */
  id: string;
  name: string;
  description: string;
  url: string;
  /**
   * 'oauth' — browser consent, which needs the authorization server to offer
   *           dynamic client registration, since Asterisk has no pre-registered
   *           client id anywhere.
   * 'token' — the user issues a token and pastes it. The fallback for servers
   *           that do not register clients dynamically.
   *
   * This is not a guess per entry: every 'oauth' below was confirmed by
   * running a real registration against it, and GitHub is 'token' because that
   * same attempt came back "does not support dynamic client registration".
   */
  auth: 'oauth' | 'token';
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
