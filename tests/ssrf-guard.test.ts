// SSRF guard tests.
//
// WebFetch validated only /^https?:\/\//, so a prompt-injected page could aim
// the agent at cloud metadata (169.254.169.254) or at Asterisk's own control
// panel on loopback — whose API writes hook commands that later run via bash.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkOutboundUrl } from '../src/tools/ssrf-guard.ts';
import { webFetchTool } from '../src/tools/webfetch.ts';

const blocked = (url: string): boolean => checkOutboundUrl(url).reason !== null;

describe('checkOutboundUrl', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env['ASTERISK_ALLOW_LOCAL_FETCH'];
    delete process.env['ASTERISK_ALLOW_LOCAL_FETCH'];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['ASTERISK_ALLOW_LOCAL_FETCH'];
    else process.env['ASTERISK_ALLOW_LOCAL_FETCH'] = saved;
  });

  it('allows ordinary public URLs', () => {
    expect(blocked('https://example.com/page')).toBe(false);
    expect(blocked('http://93.184.216.34/')).toBe(false);
    expect(blocked('https://api.github.com/repos/x/y')).toBe(false);
  });

  it('blocks cloud metadata endpoints', () => {
    expect(blocked('http://169.254.169.254/latest/meta-data/')).toBe(true);
    expect(blocked('http://metadata.google.internal/computeMetadata/v1/')).toBe(true);
    expect(blocked('http://[fd00:ec2::254]/latest/meta-data/')).toBe(true);
  });

  it('blocks loopback in every spelling', () => {
    expect(blocked('http://127.0.0.1:4321/api/secrets')).toBe(true);
    expect(blocked('http://127.1.2.3/')).toBe(true);
    expect(blocked('http://localhost:4321/api/hooks')).toBe(true);
    expect(blocked('http://[::1]:4321/')).toBe(true);
    expect(blocked('http://[::ffff:127.0.0.1]/')).toBe(true);
  });

  it('blocks private and link-local ranges', () => {
    expect(blocked('http://10.0.0.5/')).toBe(true);
    expect(blocked('http://172.16.0.1/')).toBe(true);
    expect(blocked('http://172.31.255.255/')).toBe(true);
    expect(blocked('http://192.168.1.1/')).toBe(true);
    expect(blocked('http://169.254.1.1/')).toBe(true);
    expect(blocked('http://100.64.0.1/')).toBe(true);
    expect(blocked('http://[fe80::1]/')).toBe(true);
  });

  it('does not over-block near the edges of private ranges', () => {
    expect(blocked('http://172.15.0.1/')).toBe(false);
    expect(blocked('http://172.32.0.1/')).toBe(false);
    expect(blocked('http://192.169.1.1/')).toBe(false);
    expect(blocked('http://11.0.0.1/')).toBe(false);
  });

  it('blocks internal-looking hostnames', () => {
    expect(blocked('http://db.internal/')).toBe(true);
    expect(blocked('http://printer.local/')).toBe(true);
    expect(blocked('http://app.localhost/')).toBe(true);
  });

  it('rejects non-http schemes and embedded credentials', () => {
    expect(blocked('file:///etc/passwd')).toBe(true);
    expect(blocked('gopher://example.com/')).toBe(true);
    expect(blocked('https://user:pass@example.com/')).toBe(true);
    expect(blocked('not a url')).toBe(true);
  });

  it('explains itself and names the escape hatch', () => {
    const { reason } = checkOutboundUrl('http://169.254.169.254/');
    expect(reason).toContain('169.254.169.254');
    expect(reason).toContain('ASTERISK_ALLOW_LOCAL_FETCH');
  });

  it('honours the opt-out for users who need local fetches', () => {
    process.env['ASTERISK_ALLOW_LOCAL_FETCH'] = '1';
    expect(blocked('http://127.0.0.1:8080/health')).toBe(false);
    expect(blocked('http://192.168.1.1/')).toBe(false);
    // The opt-out is about network reachability, not about scheme abuse.
    expect(blocked('file:///etc/passwd')).toBe(true);
  });
});

describe('WebFetch refuses blocked targets without making a request', () => {
  it('returns an error for the metadata endpoint', async () => {
    const result = await webFetchTool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('169.254.169.254');
  });

  it('returns an error for its own control panel', async () => {
    const result = await webFetchTool.execute({ url: 'http://127.0.0.1:4321/api/secrets' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('loopback');
  });
});
