// Host and Origin validation for the control panel.
//
// Binding to loopback is not, on its own, a security boundary against a web
// browser. Two attacks cross it:
//
//   DNS rebinding. A page the user visits resolves attacker.com to
//   127.0.0.1 on its second lookup, then issues same-origin requests to the
//   panel from a document the attacker controls. The browser's own origin
//   checks are satisfied; the only thing that distinguishes the request is the
//   Host header, which still says attacker.com. Refusing unknown Host values is
//   the standard defence.
//
//   CSRF. Any page can issue a cross-site POST to 127.0.0.1 without reading the
//   response — enough to write state. The same-site case matters too: a page
//   on some other loopback port (an ordinary dev server) is cross-origin but
//   not cross-site, so Origin — checked with its port, unlike Host — is what
//   catches it independently of Sec-Fetch-Site.
//
// Both matter here more than in a typical admin panel, because the panel writes
// the `hooks` table, whose `command` field is later executed verbatim via
// `spawn('bash', ['-lc', cmd])` on the agent's next turn. A single unauthorised
// write is arbitrary code execution as the user.

/** Methods that can change server state and therefore need origin checks. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OriginGuardOptions {
  /** Host the server was told to bind. */
  host: string;
  /** Port the server is listening on. */
  port: number;
}

/**
 * Hostnames a browser may legitimately use to reach the panel — for the Host
 * header only; see `allowedOrigins` for why Origin cannot drop the port the
 * same way.
 *
 * Names only, not host:port. The port carries no security signal — a rebinding
 * attack has to target our port to reach us at all, so what distinguishes it is
 * always the *name*: the browser sends `Host: evil.example.com:4321`. Comparing
 * names keeps the check strong and stops it from breaking on the ordinary
 * variations (omitted default port, IPv6 brackets).
 *
 * The set is the loopback spellings plus whatever the user explicitly bound. A
 * user who binds 0.0.0.0 and reaches the panel by some LAN name is out of scope
 * — they should bind that name.
 */
function allowedHostnames({ host }: OriginGuardOptions): Set<string> {
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  if (host) allowed.add(normaliseHostname(host));
  return allowed;
}

/**
 * Origins (scheme + host + port) a browser may legitimately send in an
 * Origin header when talking to this panel.
 *
 * Unlike the Host header, the port here is exactly the signal: Origin
 * identifies the page that issued the request, and a page on some other
 * loopback port is a different site as far as the browser's own same-origin
 * rules are concerned, even though it shares a hostname with the panel.
 * Comparing bare hostnames (as `allowedHostnames` correctly does for Host)
 * let a page on any other loopback port — a dev server the user is running
 * for an unrelated project is the ordinary case — pass the Origin check
 * purely on hostname, leaving Sec-Fetch-Site as the only thing standing
 * between that page and a mutating request. Building full origin strings
 * against the panel's actual port (which reflects `--port`/config, not a
 * hardcoded default) restores Origin as an independent check.
 */
function allowedOrigins(opts: OriginGuardOptions): Set<string> {
  const hostnames = new Set(['127.0.0.1', 'localhost', '::1']);
  if (opts.host) hostnames.add(normaliseHostname(opts.host));
  const origins = new Set<string>();
  for (const hostname of hostnames) {
    const bracketed = hostname.includes(':') ? `[${hostname}]` : hostname;
    origins.add(`http://${bracketed}:${opts.port}`);
  }
  return origins;
}

/** Canonical `scheme://host:port` for an Origin header value, or null when it does not parse as one. */
function normaliseOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Extracts a bare, lowercased hostname from a Host header or an origin. */
function normaliseHostname(value: string): string {
  try {
    // Parsing through URL handles ports, IPv6 brackets and case in one step.
    return new URL(value.includes('://') ? value : `http://${value}`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
  } catch {
    return value.toLowerCase();
  }
}

/**
 * Returns a refusal reason, or null when the request may proceed.
 *
 * Kept as a pure function of the request so it can be tested without binding a
 * port, in the same spirit as createRequestHandler.
 */
export function checkRequestOrigin(req: Request, opts: OriginGuardOptions): string | null {
  // Bun.serve builds req.url from the incoming Host header, so the two agree on
  // a real connection and the URL is a safe fallback for a Request constructed
  // in memory (which cannot carry a Host header — fetch forbids setting it).
  // A rebinding attempt is caught either way: the attacker's hostname appears
  // in both.
  const rawHost = req.headers.get('host') ?? new URL(req.url).host;
  if (!rawHost) return 'missing Host header';
  if (!allowedHostnames(opts).has(normaliseHostname(rawHost))) {
    // The DNS-rebinding case lands here: the socket is loopback but the name
    // the browser used is not.
    return `unexpected Host header "${rawHost}"`;
  }

  // Sec-Fetch-Site is sent by every current browser and cannot be forged by
  // page script. `none` means the user typed the URL or used a bookmark.
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return `cross-site request refused (sec-fetch-site: ${site})`;
  }

  const origin = req.headers.get('origin');
  if (origin && origin !== 'null' && !allowedOrigins(opts).has(normaliseOrigin(origin) ?? '')) {
    return `cross-origin request refused (origin: ${origin})`;
  }
  // Origin: null is what a sandboxed iframe or a data: document sends. It is
  // never the panel talking to itself.
  if (origin === 'null') return 'cross-origin request refused (opaque origin)';

  // A state-changing request from a browser always carries Origin. Its absence
  // means a non-browser client (curl, the CLI), which cannot be driven by a
  // hostile page and is therefore not the threat this guards against — but a
  // browser that somehow omitted it must not be trusted, which is what the
  // Sec-Fetch-Site check above covers.
  if (MUTATING.has(req.method) && origin === null && site === null) {
    const ua = req.headers.get('user-agent') ?? '';
    if (/mozilla|chrome|safari|edge/i.test(ua)) {
      return 'state-changing request from a browser without an Origin header';
    }
  }

  return null;
}
