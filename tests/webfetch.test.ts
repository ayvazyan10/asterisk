import { type Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { htmlToText, webFetchTool } from '../src/tools/webfetch.ts';

describe('WebFetch', () => {
  let savedLocalFetch: string | undefined;
  let savedDispatcher: Dispatcher;
  let agent: MockAgent;

  beforeEach(() => {
    savedLocalFetch = process.env['ASTERISK_ALLOW_LOCAL_FETCH'];
    delete process.env['ASTERISK_ALLOW_LOCAL_FETCH'];
    savedDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    if (savedLocalFetch === undefined) delete process.env['ASTERISK_ALLOW_LOCAL_FETCH'];
    else process.env['ASTERISK_ALLOW_LOCAL_FETCH'] = savedLocalFetch;
    setGlobalDispatcher(savedDispatcher);
    await agent.close();
  });

  it('follows relative and absolute redirects and reports the final URL', async () => {
    const origin = agent.get('https://example.com');
    origin.intercept({ path: '/start' }).reply(301, 'discard this', {
      headers: { location: '/next' },
    });
    origin.intercept({ path: '/next' }).reply(302, 'discard this too', {
      headers: { location: 'https://example.org/final' },
    });
    agent
      .get('https://example.org')
      .intercept({ path: '/final' })
      .reply(200, 'final content', {
        headers: { 'content-type': 'text/plain' },
      });

    const result = await webFetchTool.execute({ url: 'https://example.com/start' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('URL: https://example.org/final\n');
    expect(result.output).toContain('final content');
    expect(result.output).not.toContain('discard this');
    agent.assertNoPendingInterceptors();
  });

  it.each(['http://127.0.0.1:4321/private', 'http://169.254.169.254/latest/meta-data/'])(
    'refuses a redirect to %s with the local-fetch override off',
    async (location) => {
      agent.get('https://example.com').intercept({ path: '/' }).reply(302, '', {
        headers: { location },
      });
      let reached = false;
      const target = new URL(location);
      agent
        .get(target.origin)
        .intercept({ path: target.pathname })
        .reply(() => {
          reached = true;
          return { statusCode: 200, data: 'private' };
        });

      const result = await webFetchTool.execute({ url: 'https://example.com/' });

      expect(result.isError).toBe(true);
      expect(result.output).toContain('ASTERISK_ALLOW_LOCAL_FETCH');
      expect(result.output).toContain(target.hostname);
      expect(reached).toBe(false);
    },
  );

  it('allows exactly five redirect hops', async () => {
    const origin = agent.get('https://example.com');
    for (let hop = 0; hop < 5; hop++) {
      origin.intercept({ path: `/${hop}` }).reply(302, '', {
        headers: { location: `/${hop + 1}` },
      });
    }
    origin.intercept({ path: '/5' }).reply(200, 'done');

    const result = await webFetchTool.execute({ url: 'https://example.com/0' });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('URL: https://example.com/5\n');
    agent.assertNoPendingInterceptors();
  });

  it('stops a redirect loop after five hops', async () => {
    let requests = 0;
    agent
      .get('https://example.com')
      .intercept({ path: '/' })
      .reply(() => {
        requests++;
        return { statusCode: 302, data: '', responseOptions: { headers: { location: '/' } } };
      })
      .persist();

    const result = await webFetchTool.execute({ url: 'https://example.com/' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Too many redirects');
    expect(requests).toBe(6);
  });

  it.each(['charset=cp1251', 'CHARSET="windows-1251"', "charset='windows-1251'"])(
    'decodes Cyrillic text with %s',
    async (charset) => {
      agent
        .get('https://example.com')
        .intercept({ path: '/' })
        .reply(200, Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), {
          headers: { 'content-type': `text/plain; ${charset}` },
        });

      const result = await webFetchTool.execute({ url: 'https://example.com/' });

      expect(result.isError).toBe(false);
      expect(result.output).toContain('Привет');
    },
  );

  it.each(['text/plain', 'text/plain; charset=unknown-charset'])(
    'uses UTF-8 for %s',
    async (ctype) => {
      agent
        .get('https://example.com')
        .intercept({ path: '/' })
        .reply(200, 'Привет 😀', {
          headers: { 'content-type': ctype },
        });

      const result = await webFetchTool.execute({ url: 'https://example.com/' });

      expect(result.isError).toBe(false);
      expect(result.output).toContain('Привет 😀');
    },
  );
});

describe('htmlToText entities', () => {
  it('decodes ampersands last without recursively decoding escaped entities', () => {
    expect(htmlToText('&amp;lt; &amp;#x27; &amp;#128512; &amp;amp;')).toBe(
      '&lt; &#x27; &#128512; &amp;',
    );
    expect(htmlToText('&lt; &gt; &quot; &#39; &nbsp; &amp;')).toBe('< > " \' &');
  });

  it('decodes decimal and hexadecimal Unicode code points', () => {
    expect(htmlToText('&#x27; &#X27; &#128512; &#x1F600;')).toBe("' ' 😀 😀");
  });

  it('leaves invalid code points unchanged', () => {
    const invalid = '&#1114112; &#x110000; &#55296; &#xDFFF; &#99999999999999999999;';
    expect(htmlToText(invalid)).toBe(invalid);
  });
});
