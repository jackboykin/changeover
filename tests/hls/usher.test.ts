import { describe, it, expect, mock } from 'bun:test';
import type { GQLHeaders } from '../../src/types';
import { mintUsherUrl, SITE_FLAVOR, type UsherTarget } from '../../src/hls/usher';

const headers: GQLHeaders = {
  clientId: 'client-id',
  deviceId: 'device',
  authorization: 'OAuth token',
  integrity: null,
  version: null,
  session: null,
  accessTokenHash: null,
};

const channel = (channelName: string, usherParams = ''): UsherTarget => ({
  channelName,
  usherParams,
  isUsherV2: false,
});

describe('mintUsherUrl flavors', () => {
  function captureNet() {
    const bodies: Record<string, unknown>[] = [];
    const f = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('gql')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(
          Response.json({ data: { streamPlaybackAccessToken: { signature: 'SIG', value: 'TOK' } } }),
        );
      }
      return Promise.resolve(new Response('#EXTM3U'));
    });
    return { fetch: f as unknown as typeof fetch, bodies };
  }

  it('site flavor requests a site/web token', async () => {
    const net = captureNet();
    const url = await mintUsherUrl(
      { ...channel('streamer', '?allow_source=true'), isUsherV2: true },
      headers,
      net.fetch,
      SITE_FLAVOR,
    );

    const vars = net.bodies[0]!['variables'] as Record<string, unknown>;
    expect(vars['playerType']).toBe('site');
    expect(vars['platform']).toBe('web');
    expect(url).toContain('/api/v2/channel/hls/streamer.m3u8');
    expect(url).toContain('allow_source=true');
    expect(url).toContain('sig=SIG');
    expect(url).toContain('token=TOK');
  });

  it('returns null when the token is refused', async () => {
    const refuse = mock(() => Promise.resolve(new Response('', { status: 401 })));
    expect(
      await mintUsherUrl(channel('streamer'), headers, refuse as unknown as typeof fetch, SITE_FLAVOR),
    ).toBeNull();
  });
});
