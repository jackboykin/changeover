import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getGQLHeaders, installFetchHook, setM3U8Processor } from '../../src/hooks/fetch-hook';
import { TWITCH_CLIENT_ID, GQL_URL } from '../../src/utils/constants';

describe('installFetchHook integration', () => {
  const g = globalThis as unknown as {
    window?: {
      fetch: typeof fetch;
      location: { href: string };
    };
  };

  const originalWindow = g.window;

  beforeEach(() => {
    setM3U8Processor(null);
    g.window = {
      fetch: mock(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      location: { href: 'https://www.twitch.tv/test-channel' },
    };
  });

  afterEach(() => {
    setM3U8Processor(null);
    if (originalWindow) {
      g.window = originalWindow;
    } else {
      delete g.window;
    }
  });

  it('captures GQL headers and PlaybackAccessToken hash through hooked fetch', async () => {
    installFetchHook();
    await g.window!.fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'X-Device-Id': 'dev-1',
        Authorization: 'OAuth token-1',
      },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken',
        extensions: { persistedQuery: { sha256Hash: 'hash-abc' } },
      }),
    });

    const h = getGQLHeaders();
    expect(h.clientId).toBe(TWITCH_CLIENT_ID);
    expect(h.deviceId).toBe('dev-1');
    expect(h.authorization).toBe('OAuth token-1');
    expect(h.accessTokenHash).toBe('hash-abc');
  });

  it('does not capture headers for non-GQL URLs containing "gql"', async () => {
    installFetchHook();
    const before = getGQLHeaders().deviceId;

    await g.window!.fetch('https://example.com/path?gql=true', {
      method: 'POST',
      headers: { 'X-Device-Id': 'dev-should-not-capture' },
      body: JSON.stringify({
        operationName: 'PlaybackAccessToken',
        extensions: { persistedQuery: { sha256Hash: 'hash-should-not-capture' } },
      }),
    });

    expect(getGQLHeaders().deviceId).toBe(before);
    expect(getGQLHeaders().deviceId).not.toBe('dev-should-not-capture');
  });

  it('routes HLS playlist responses through processor in main-thread interception path', async () => {
    const handleMasterPlaylist = mock((_: string, __: string) => '#EXTM3U\n#master-processed');
    const handleMediaPlaylist = mock(async (_: string, __: string) => '#EXTM3U\n#media-processed');
    setM3U8Processor({
      isKnownAdSegment: () => false,
      handleMasterPlaylist,
      handleMediaPlaylist,
    } as unknown as Parameters<typeof setM3U8Processor>[0]);

    g.window!.fetch = mock(
      async () => new Response('#EXTM3U\n#original', { status: 200 }),
    ) as unknown as typeof fetch;
    installFetchHook();

    const masterResp = await g.window!.fetch('https://usher.ttvnw.net/api/channel/hls/streamer.m3u8');
    expect(await masterResp.text()).toContain('#master-processed');
    expect(handleMasterPlaylist).toHaveBeenCalledTimes(1);

    const mediaResp = await g.window!.fetch('https://video-edge.example.com/media-1.m3u8');
    expect(await mediaResp.text()).toContain('#media-processed');
    expect(handleMediaPlaylist).toHaveBeenCalledTimes(1);
  });

  it('returns a real fetch that survives being called as a method', async () => {
    g.window!.fetch = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response('ok'));
    } as unknown as typeof fetch;
    const holder = { realFetch: installFetchHook() };

    expect(await (await holder.realFetch('https://usher.ttvnw.net/x.m3u8')).text()).toBe('ok');
  });

  it('captures the latest value when a header changes across requests', async () => {
    installFetchHook();
    await g.window!.fetch(GQL_URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'dev-a' },
      body: '',
    });
    expect(getGQLHeaders().deviceId).toBe('dev-a');

    await g.window!.fetch(GQL_URL, {
      method: 'POST',
      headers: { 'X-Device-Id': 'dev-b' },
      body: '',
    });
    expect(getGQLHeaders().deviceId).toBe('dev-b');
  });

  it('captureAccessTokenHash ignores non-PlaybackAccessToken operations', async () => {
    installFetchHook();
    const before = getGQLHeaders().accessTokenHash;

    await g.window!.fetch(GQL_URL, {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'SomeOtherQuery',
        extensions: { persistedQuery: { sha256Hash: 'should-not-capture' } },
      }),
    });

    expect(getGQLHeaders().accessTokenHash).toBe(before);
  });

  it('captureAccessTokenHash tolerates non-JSON body without throwing', async () => {
    installFetchHook();

    await expect(
      g.window!.fetch(GQL_URL, { method: 'POST', body: 'not-valid-json{' }),
    ).resolves.toBeDefined();
  });
});
