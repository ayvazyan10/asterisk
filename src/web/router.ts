// Route table for the control panel API.
//
// Patterns use `:name` for a single captured segment and a trailing `*` for
// one-or-more captured segments. Captures arrive in the handler as
// `ctx.params`, in order. First match wins, so specific routes precede
// general ones.

import type { Handler } from './http.ts';
import {
  exportConfig,
  getSecrets,
  getSettings,
  importConfig,
  patchSettings,
  putSecret,
  resetSetting,
} from './api/config.ts';
import {
  getHooks,
  getMcpServers,
  putHook,
  putMcpServer,
  removeHook,
  removeMcpServer,
} from './api/collections.ts';
import { deleteContent, listContent, readContent, writeContent } from './api/content.ts';
import {
  deleteUsage,
  getPricing,
  getUsage,
  putPricing,
  removePricing,
} from './api/usage.ts';
import {
  daemonAction,
  deleteToken,
  getAudit,
  getDoctor,
  getLogs,
  getStatus,
  getTokens,
  postToken,
} from './api/system.ts';

export interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', pattern: '/api/status', handler: getStatus },
  { method: 'GET', pattern: '/api/doctor', handler: getDoctor },
  { method: 'GET', pattern: '/api/logs', handler: getLogs },
  { method: 'GET', pattern: '/api/audit', handler: getAudit },

  { method: 'GET', pattern: '/api/usage', handler: getUsage },
  { method: 'DELETE', pattern: '/api/usage', handler: deleteUsage },
  { method: 'GET', pattern: '/api/pricing', handler: getPricing },
  { method: 'PUT', pattern: '/api/pricing', handler: putPricing },
  { method: 'DELETE', pattern: '/api/pricing/:model', handler: removePricing },

  { method: 'GET', pattern: '/api/settings', handler: getSettings },
  { method: 'PATCH', pattern: '/api/settings', handler: patchSettings },
  { method: 'POST', pattern: '/api/settings/reset', handler: resetSetting },

  { method: 'GET', pattern: '/api/secrets', handler: getSecrets },
  { method: 'PUT', pattern: '/api/secrets', handler: putSecret },

  { method: 'GET', pattern: '/api/mcp', handler: getMcpServers },
  { method: 'PUT', pattern: '/api/mcp', handler: putMcpServer },
  { method: 'DELETE', pattern: '/api/mcp/:name', handler: removeMcpServer },

  { method: 'GET', pattern: '/api/hooks', handler: getHooks },
  { method: 'PUT', pattern: '/api/hooks', handler: putHook },
  { method: 'DELETE', pattern: '/api/hooks/:name', handler: removeHook },

  // Ordering matters: the file routes are more specific than the listings.
  { method: 'GET', pattern: '/api/content/:kind/*', handler: readContent },
  { method: 'PUT', pattern: '/api/content/:kind/*', handler: writeContent },
  { method: 'DELETE', pattern: '/api/content/:kind/*', handler: deleteContent },
  { method: 'GET', pattern: '/api/content/:kind', handler: listContent },
  { method: 'GET', pattern: '/api/content', handler: listContent },

  { method: 'GET', pattern: '/api/config/export', handler: exportConfig },
  { method: 'POST', pattern: '/api/config/import', handler: importConfig },

  { method: 'GET', pattern: '/api/tokens', handler: getTokens },
  { method: 'POST', pattern: '/api/tokens', handler: postToken },
  { method: 'DELETE', pattern: '/api/tokens/:id', handler: deleteToken },

  { method: 'POST', pattern: '/api/daemon/:action', handler: daemonAction },
];

export interface Match {
  handler: Handler;
  params: string[];
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function matchPattern(pattern: string, segments: string[]): string[] | undefined {
  const parts = splitPath(pattern);
  const params: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;

    if (part === '*') {
      const rest = segments.slice(i);
      if (rest.length === 0) return undefined;
      params.push(...rest.map(decodeSegment));
      return params;
    }

    const segment = segments[i];
    if (segment === undefined) return undefined;

    if (part.startsWith(':')) {
      params.push(decodeSegment(segment));
      continue;
    }
    if (part !== segment) return undefined;
  }

  return segments.length === parts.length ? params : undefined;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is passed through rather than throwing; downstream
    // path validation will reject anything dangerous.
    return segment;
  }
}

/** Finds the handler for a method+path, or reports which methods would match. */
export function matchRoute(
  method: string,
  path: string,
): Match | { allowed: string[] } | undefined {
  const segments = splitPath(path);
  const allowed = new Set<string>();

  for (const route of ROUTES) {
    const params = matchPattern(route.pattern, segments);
    if (!params) continue;
    if (route.method === method) return { handler: route.handler, params };
    allowed.add(route.method);
  }

  return allowed.size > 0 ? { allowed: [...allowed] } : undefined;
}
