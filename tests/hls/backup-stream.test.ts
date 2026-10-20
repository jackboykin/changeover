import { describe, it, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import type { GQLHeaders, StreamVariant } from '../../src/types';
import {
  BackupStreamManager,
  mintUsherUrl,
  SITE_FLAVOR,
  type UsherTarget,
} from '../../src/hls/backup-stream';
import { clearTrace, traceEntries } from '../../src/trace';

const headers: GQLHeaders = {
  clientId: 'client-id',
  deviceId: 'device',
  authorization: 'OAuth token',
  integrity: null,
  version: null,
  session: null,
  accessTokenHash: null,
};

const variant: StreamVariant = {
  url: 'https://video-edge.example.com/1080p60.m3u8',
  resolution: '1920x1080',
  width: 1920,
  height: 1080,
  frameRate: 60,
  codecs: 'avc1.64002A,mp4a.40.2',
  isHEVC: false,
};

const BACKUP_MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002A"',
  'https://backup-edge.example.com/1080p60.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.4D401F"',
  'https://backup-edge.example.com/720p30.m3u8',
].join('\n');

const CLEAN_MEDIA = ['#EXTM3U', '#EXTINF:2.000,live', 'backup1.ts'].join('\n');
const STITCHED_MEDIA = ['#EXTM3U', '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"', 'ad.ts'].join('\n');

const channel = (channelName: string, usherParams = ''): UsherTarget => ({
  channelName,
  usherParams,
  isUsherV2: false,
});

let netFetch: typeof fetch;
const use = <F>(f: F): F => {
  netFetch = f as unknown as typeof fetch;
  return f;
};

function fakeNet() {
  let body = CLEAN_MEDIA;
  let status = 200;
  let once: { body: string; status: number } | null = null;

  const f = mock((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('gql')) {
      return Promise.resolve(
        Response.json({ data: { streamPlaybackAccessToken: { signature: 'sig', value: 'tok' } } }),
      );
    }
    if (url.includes('usher')) {
      return Promise.resolve(new Response(BACKUP_MASTER));
    }
    const one = once;
    once = null;
    return Promise.resolve(new Response(one?.body ?? body, { status: one?.status ?? status }));
  });

  use(f);
  return {
    fetch: f as unknown as typeof fetch,
    calls: () => f.mock.calls,
    mediaBody: (b: string, s = 200) => {
      body = b;
      status = s;
    },
    mediaOnce: (b: string, s: number) => {
      once = { body: b, status: s };
    },
  };
}

let mgr: BackupStreamManager;

beforeEach(() => {
  clearTrace();
  mgr = new BackupStreamManager(() => headers, ((input, init) => netFetch(input, init)) as typeof fetch);
});

afterEach(() => {
  mgr.release('streamer');
  setSystemTime();
});

const acquires = () => traceEntries().filter((e) => e.ev === 'acquired').length;

const poll = () => mgr.poll(channel('streamer', '?allow_source=true'), variant);

const expireCache = () => setSystemTime(new Date(Date.now() + 3_000));

const passBreak = () => setSystemTime(new Date(Date.now() + 60_000));

describe('sticky session', () => {
  it('acquires once and serves later polls from cache, off the network', async () => {
    const net = fakeNet();

    expect(await poll()).toBe(CLEAN_MEDIA);
    const fetches = net.calls().length;
    expect(await poll()).toBe(CLEAN_MEDIA);
    expect(await poll()).toBe(CLEAN_MEDIA);

    expect(acquires()).toBe(1);
    expect(net.calls().length).toBe(fetches);
  });

  it('goes to the network when the cached copy has aged out', async () => {
    const net = fakeNet();
    await poll();
    const fetches = net.calls().length;
    expireCache();
    expect(await poll()).toBe(CLEAN_MEDIA);
    expect(net.calls().length).toBe(fetches + 1);
    expect(acquires()).toBe(1);
  });

  it('re-acquires after release (i.e. the channel went away)', async () => {
    fakeNet();
    await poll();
    mgr.release('streamer');
    await poll();
    expect(acquires()).toBe(2);
  });

  it('keeps the session across a break so the next one starts warm', async () => {
    fakeNet();
    await poll();
    mgr.endBreak('streamer');
    passBreak();

    expect(await poll()).toBe(CLEAN_MEDIA);
    expect(acquires()).toBe(1);
  });

  it('re-acquires within the same poll when a parked session has aged out', async () => {
    const net = fakeNet();
    await poll();
    mgr.endBreak('streamer');
    passBreak();

    net.mediaOnce('', 404);

    expect(await poll()).toBe(CLEAN_MEDIA);
    expect(acquires()).toBe(2);
  });

  it('drops the session and re-acquires when the backup catches its own ad', async () => {
    const net = fakeNet();
    expect(await poll()).toBe(CLEAN_MEDIA);

    net.mediaBody(STITCHED_MEDIA);
    expireCache();
    expect(await poll()).toBeNull();

    net.mediaBody(CLEAN_MEDIA);
    expect(await poll()).toBe(CLEAN_MEDIA);
    expect(acquires()).toBe(2);
  });

  it('drops the session when the media playlist dies', async () => {
    const net = fakeNet();
    await poll();
    net.mediaBody('', 404);
    expireCache();
    expect(await poll()).toBeNull();

    net.mediaBody(CLEAN_MEDIA);
    expect(await poll()).toBe(CLEAN_MEDIA);
  });
});

describe('variant matching', () => {
  it('picks the rendition matching the resolution and frame rate being played', async () => {
    const net = fakeNet();
    await poll();
    const calls = net.calls();
    expect(String(calls[calls.length - 1]![0])).toBe('https://backup-edge.example.com/1080p60.m3u8');
  });

  it('falls back to the closest resolution by area', async () => {
    const net = fakeNet();
    const odd: StreamVariant = { ...variant, resolution: '1152x648', width: 1152, height: 648 };
    await mgr.poll(channel('streamer'), odd);
    const calls = net.calls();
    expect(String(calls[calls.length - 1]![0])).toBe('https://backup-edge.example.com/720p30.m3u8');
  });
});

describe('regressions', () => {
  it('follows ABR to another rendition from the ladder it holds, without a token', async () => {
    const net = fakeNet();
    await poll();

    const smaller: StreamVariant = { ...variant, resolution: '1280x720', width: 1280, height: 720 };
    expect(await mgr.poll(channel('streamer'), smaller)).toBe(CLEAN_MEDIA);

    expect(acquires()).toBe(1);
    const calls = net.calls();
    expect(String(calls[calls.length - 1]![0])).toBe('https://backup-edge.example.com/720p30.m3u8');
  });

  it('a switch that picks the playlist already served costs nothing', async () => {
    const net = fakeNet();
    const odd: StreamVariant = { ...variant, resolution: '1152x648', width: 1152, height: 648 };
    await mgr.poll(channel('streamer'), odd);
    const fetches = net.calls().length;

    const near: StreamVariant = { ...variant, resolution: '1024x576', width: 1024, height: 576 };
    expect(await mgr.poll(channel('streamer'), near)).toBe(CLEAN_MEDIA);
    expect(net.calls().length).toBe(fetches);
  });

  it('backs off per channel — a dead channel must not starve a live one', async () => {
    use(mock(() => Promise.resolve(new Response('', { status: 500 }))));
    expect(await mgr.poll(channel('dead'), variant)).toBeNull();

    fakeNet();
    expect(await mgr.poll(channel('healthy'), variant)).toBe(CLEAN_MEDIA);
  });
});

describe('flavor tiering (source quality first, android floor)', () => {
  const WEB_MASTER = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,FRAME-RATE=60.000,CODECS="hev1.1.6.L150"',
    'https://web-edge.example.com/1440p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002A"',
    'https://web-edge.example.com/1080p60.m3u8',
  ].join('\n');
  const ANDROID_MASTER = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002A"',
    'https://backup-edge.example.com/1080p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="avc1.4D401F"',
    'https://backup-edge.example.com/720p30.m3u8',
  ].join('\n');

  const target1440: StreamVariant = {
    url: 'x',
    resolution: '2560x1440',
    width: 2560,
    height: 1440,
    frameRate: 60,
    codecs: 'hev1.1.6.L150',
    isHEVC: true,
  };

  function tieredNet(webStitched: boolean, slowMs: Record<string, number> = {}) {
    const f = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('gql')) {
        const flavor = (JSON.parse(String(init?.body)) as { variables: { playerType: string } }).variables
          .playerType;
        const token = Response.json({
          data: { streamPlaybackAccessToken: { signature: 's', value: flavor } },
        });
        return new Promise<Response>((r) => setTimeout(() => r(token), slowMs[flavor] ?? 0));
      }
      if (url.includes('usher')) {
        const isWeb = url.includes('token=embed') || url.includes('token=popout');
        return Promise.resolve(new Response(isWeb ? WEB_MASTER : ANDROID_MASTER));
      }
      const isWeb = url.includes('web-edge');
      return Promise.resolve(new Response(isWeb && webStitched ? STITCHED_MEDIA : CLEAN_MEDIA));
    });
    use(f);
    return { calls: () => f.mock.calls.map(([input]) => String(input)) };
  }

  const won = () => traceEntries().find((e) => e.ev === 'acquired')?.data?.['flavor'];
  const matched = () => traceEntries().filter((e) => e.ev === 'variant-match');

  it('keeps source quality: a clean embed (web) wins', async () => {
    tieredNet(false);
    expect(await mgr.poll(channel('streamer'), target1440)).toBe(CLEAN_MEDIA);

    expect(won()).toBe('embed');
    expect(matched().map((e) => [e.data?.['chosen'], e.data?.['exact']])).toEqual([['2560x1440', true]]);
  });

  it('falls to the android floor when the web flavors are mid-ad', async () => {
    tieredNet(true);
    expect(await mgr.poll(channel('streamer'), target1440)).toBe(CLEAN_MEDIA);

    expect(won()).toBe('autoplay');
    const stitched = traceEntries().filter((e) => e.ev === 'flavor-stitched');
    expect(stitched.map((e) => e.data?.['flavor'])).toEqual(['embed', 'popout']);
    expect(matched().map((e) => [e.data?.['chosen'], e.data?.['exact']])).toEqual([['1920x1080', false]]);
  });

  it('runs every flavor at once rather than one after another', async () => {
    const net = tieredNet(true);
    await mgr.poll(channel('streamer'), target1440);
    expect(
      net
        .calls()
        .slice(0, 3)
        .every((url) => url.includes('gql')),
    ).toBe(true);
  });

  it('a faster floor never beats a clean, slower embed', async () => {
    tieredNet(false, { embed: 5 });
    await mgr.poll(channel('streamer'), target1440);
    expect(won()).toBe('embed');
  });
});

describe('release during acquire', () => {
  it('discards an acquire whose break ended while it was in flight', async () => {
    use((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('gql')) {
        return new Promise<Response>((r) =>
          setTimeout(
            () => r(Response.json({ data: { streamPlaybackAccessToken: { signature: 's', value: 't' } } })),
            2,
          ),
        );
      }
      if (url.includes('usher')) return Promise.resolve(new Response(BACKUP_MASTER));
      return Promise.resolve(new Response(CLEAN_MEDIA));
    });

    const inFlight = mgr.poll(channel('streamer'), variant);
    mgr.release('streamer');
    expect(await inFlight).toBeNull();
    expect(traceEntries().find((e) => e.ev === 'acquire-discarded')).toBeDefined();

    clearTrace();
    const atBreakEnd = mgr.poll(channel('streamer'), variant);
    mgr.endBreak('streamer');
    expect(await atBreakEnd).toBeNull();
    expect(traceEntries().find((e) => e.ev === 'acquire-discarded')).toBeDefined();

    clearTrace();
    expect(await mgr.poll(channel('streamer'), variant)).toBe(CLEAN_MEDIA);
    expect(traceEntries().find((e) => e.ev === 'acquired')).toBeDefined();
  });
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

describe('failure handling', () => {
  it('returns null and backs off when the token cannot be fetched', async () => {
    const dead = use(mock(() => Promise.resolve(new Response('', { status: 500 }))));
    expect(await mgr.poll(channel('streamer'), variant)).toBeNull();

    const before = dead.mock.calls.length;
    expect(await mgr.poll(channel('streamer'), variant)).toBeNull();
    expect(dead.mock.calls.length).toBe(before);
  });

  it('survives a throwing fetch', async () => {
    use(mock(() => Promise.reject(new Error('network down'))));
    expect(await mgr.poll(channel('streamer'), variant)).toBeNull();
  });

  it('returns null when the backup master has no usable variants', async () => {
    use((input: RequestInfo | URL) => {
      if (String(input).includes('gql')) {
        return Promise.resolve(
          Response.json({ data: { streamPlaybackAccessToken: { signature: 's', value: 't' } } }),
        );
      }
      return Promise.resolve(new Response('#EXTM3U'));
    });

    expect(await mgr.poll(channel('streamer'), variant)).toBeNull();
  });
});
