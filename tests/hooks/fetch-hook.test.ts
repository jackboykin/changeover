import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getGQLHeaders, installFetchHook } from '../../src/hooks/fetch-hook';
import type { M3U8Processor } from '../../src/hls/m3u8-processor';
import { TWITCH_CLIENT_ID, GQL_URL } from '../../src/utils/constants';

const processor = (serve: M3U8Processor['serve'] = async (_url, text) => text) =>
  ({ isKnownAdSegment: () => false, serve }) as unknown as M3U8Processor;

describe('installFetchHook integration', () => {
  const g = globalThis as unknown as {
    window?: {
      fetch: typeof fetch;
      location: { href: string };
    };
  };

  const originalWindow = g.window;

  beforeEach(() => {
    g.window = {
      fetch: mock(async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      location: { href: 'https://www.twitch.tv/test-channel' },
    };
  });

  afterEach(() => {
    if (originalWindow) {
      g.window = originalWindow;
    } else {
      delete g.window;
    }
  });

  it('captures GQL headers and PlaybackAccessToken hash through hooked fetch', async () => {
    installFetchHook(processor());
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
    installFetchHook(processor());
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
    const serve = mock(async (_url: string, _text: string, isMaster: boolean) =>
      isMaster ? '#EXTM3U\n#master-processed' : '#EXTM3U\n#media-processed',
    );

    g.window!.fetch = mock(
      async () => new Response('#EXTM3U\n#original', { status: 200 }),
    ) as unknown as typeof fetch;
    installFetchHook(processor(serve));

    const masterResp = await g.window!.fetch('https://usher.ttvnw.net/api/channel/hls/streamer.m3u8');
    expect(await masterResp.text()).toContain('#master-processed');

    const mediaResp = await g.window!.fetch('https://video-edge.example.com/media-1.m3u8');
    expect(await mediaResp.text()).toContain('#media-processed');
    expect(serve).toHaveBeenCalledTimes(2);
  });

  it('captures the latest value when a header changes across requests', async () => {
    installFetchHook(processor());
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
    installFetchHook(processor());
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
    installFetchHook(processor());

    await expect(
      g.window!.fetch(GQL_URL, { method: 'POST', body: 'not-valid-json{' }),
    ).resolves.toBeDefined();
  });
});
