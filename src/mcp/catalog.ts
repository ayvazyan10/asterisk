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
// Requirements for an entry: a publicly documented Streamable HTTP endpoint
// (our client speaks no legacy SSE transport) that authenticates with OAuth
// and supports dynamic client registration, since Asterisk has no
// pre-registered client id with anyone. Anything else belongs in the Add
// form, where the user supplies what they know.

export interface CatalogConnector {
  /** Also the MCP server name, so it must be unique and shell-safe. */
  id: string;
  name: string;
  description: string;
  url: string;
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
    scopes: [],
    popular: true,
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and update pages and databases.',
    url: 'https://mcp.notion.com/mcp',
    scopes: [],
    popular: true,
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repositories, issues, pull requests and code search.',
    url: 'https://api.githubcopilot.com/mcp/',
    scopes: [],
    popular: true,
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Jira, Confluence, Bitbucket and Compass.',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    scopes: [],
    popular: false,
    docs: 'https://github.com/atlassian/atlassian-mcp-server',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Issues, events and release health.',
    url: 'https://mcp.sentry.dev/mcp',
    scopes: [],
    popular: false,
    docs: 'https://mcp.sentry.dev/',
  },
];

export function findCatalogConnector(id: string): CatalogConnector | undefined {
  return BUNDLED_CONNECTORS.find((c) => c.id === id);
}
