import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { GQLHeaders } from '../../src/types';

let flushes = 0;
const switches: string[] = [];
let switchable = false;
let handBacks = 0;
const breakActiveCalls: boolean[] = [];

mock.module('../../src/player/player', () => ({
  findIVSPlayer: () => null,
  setFreshPathMint: () => {},
  hardFlush: () => {
    flushes++;
    return Promise.resolve(true);
  },
  switchRendition: (to: { codecs: string }) => {
    switches.push(to.codecs);
    return switchable ? { prev: { name: '1440p60' }, wasAuto: false } : null;
  },
  handBack: () => handBacks++,
}));

mock.module('../../src/player/observer', () => ({
  setBreakActive: (active: boolean) => breakActiveCalls.push(active),
  installObserver: () => {},
}));

const { M3U8Processor, markAdSegments, liveNumbered } = await import('../../src/hls/m3u8-processor');
const { traceEntries, clearTrace } = await import('../../src/trace');

const headers: GQLHeaders = {
  clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  deviceId: null,
  authorization: null,
  integrity: null,
  version: null,
  session: null,
  accessTokenHash: null,
};

const MASTER_URL = 'https://usher.ttvnw.net/api/channel/hls/testchannel.m3u8?allow_source=true';
const AVC_URL = 'https://video-edge.example.com/1080p60.m3u8';
const HEVC_URL = 'https://video-edge.example.com/1440p60.m3u8';

const AVC_MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002A,mp4a.40.2"',
  AVC_URL,
].join('\n');
const HEVC_MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,FRAME-RATE=60.000,CODECS="hev1.1.6.L153.B0,mp4a.40.2"',
  HEVC_URL,
].join('\n');

const CLEAN = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:100', '#EXTINF:2.000,live', 'live1.ts'].join('\n');
const AD = [
  '#EXTM3U',
  '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad",X-TV-TWITCH-AD-URL="https://tracker.example/beacon"',
  '#EXTINF:2.000,',
  'ad1.ts',
  '#EXTINF:2.000,live',
  'live1.ts',
].join('\n');
const BACKUP = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:5000', '#EXTINF:2.000,live', 'backup1.ts'].join('\n');

const DISCONTINUITY = '#EXT-X-DISCONTINUITY';

function backupFetch(mediaBody = BACKUP, master = AVC_MASTER): typeof fetch {
  return mock((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('gql')) {
      return Promise.resolve(
        Response.json({ data: { streamPlaybackAccessToken: { signature: 'sig', value: 'tok' } } }),
      );
    }
    if (url.includes('usher')) return Promise.resolve(new Response(master));
    return Promise.resolve(new Response(mediaBody));
  }) as unknown as typeof fetch;
}

const deadFetch = mock(() => Promise.resolve(new Response('', { status: 500 }))) as unknown as typeof fetch;

function makeProcessor(f: typeof fetch) {
  return new M3U8Processor(() => headers, f);
}

function decisions() {
  return traceEntries().filter((e) => e.cat === 'poll' && e.ev === 'decision');
}

beforeEach(() => {
  clearTrace();
  flushes = 0;
  switches.length = 0;
  switchable = false;
  handBacks = 0;
  breakActiveCalls.length = 0;
});

describe('clean playback', () => {
  it('passes a clean playlist through untouched and reloads nothing', async () => {
    const proc = makeProcessor(deadFetch);
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    const out = await proc.handleMediaPlaylist(AVC_URL, CLEAN);

    expect(out).toBe(CLEAN);
    expect(flushes).toBe(0);
    expect(breakActiveCalls).toEqual([]);
    expect(decisions()[0]!.data).toMatchObject({ inAd: false });
  });

  it('serves the master untouched', () => {
    const proc = makeProcessor(deadFetch);
    expect(proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER)).toBe(HEVC_MASTER);
  });

  it('ignores a media playlist for an unknown channel', async () => {
    const proc = makeProcessor(deadFetch);
    expect(await proc.handleMediaPlaylist(AVC_URL, AD)).toBe(AD);
  });
});

describe('ad break substitutes the raw backup', () => {
  it('serves the raw backup on AVC', async () => {
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    await proc.handleMediaPlaylist(AVC_URL, CLEAN);

    expect(await proc.handleMediaPlaylist(AVC_URL, AD)).toBe(BACKUP);
  });

  it('returns to live untouched on an AVC break, with no flush', async () => {
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    await proc.handleMediaPlaylist(AVC_URL, CLEAN);
    await proc.handleMediaPlaylist(AVC_URL, AD);

    const back = await proc.handleMediaPlaylist(AVC_URL, CLEAN);
    expect(back).toBe(CLEAN);
    expect(flushes).toBe(0);
  });
});

describe('live numbering', () => {
  const seqs = (media: number, live: number, body: string) =>
    ['#EXTM3U', `#EXT-X-MEDIA-SEQUENCE:${media}`, `#EXT-X-TWITCH-LIVE-SEQUENCE:${live}`, body].join('\n');
  const STITCHED = '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"\n#EXTINF:2.002,live\nlive1.ts';
  const SEG = '#EXTINF:2.002,live\nlive1.ts';

  it('shows the player one numbering across the swap in and out', async () => {
    const proc = makeProcessor(backupFetch(seqs(10121, 10121, SEG)));
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);

    expect(await proc.handleMediaPlaylist(AVC_URL, seqs(10123, 10119, SEG))).toBe(seqs(10119, 10119, SEG));
    expect(await proc.handleMediaPlaylist(AVC_URL, seqs(10124, 10120, STITCHED))).toBe(
      seqs(10121, 10121, SEG),
    );
    expect(await proc.handleMediaPlaylist(AVC_URL, seqs(10130, 10122, SEG))).toBe(seqs(10122, 10122, SEG));
  });

  it('ignores a LIVE-SEQUENCE that only appears after the ads', () => {
    const inline = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:10840', '#EXTINF:2.000,', 'ad1.ts'];
    const text = [...inline, '#EXT-X-TWITCH-LIVE-SEQUENCE:10906', SEG].join('\n');
    expect(liveNumbered(text)).toBe(text);
    expect(liveNumbered(BACKUP)).toBe(BACKUP);
  });
});

describe('codec seam (flush at the return)', () => {
  it('flushes after an HEVC break served from an AVC backup', async () => {
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);
    await proc.handleMediaPlaylist(HEVC_URL, AD);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

    expect(flushes).toBe(1);
  });

  it('hands a seam to the player as a rendition switch, and hands it back with no reload', async () => {
    switchable = true;
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);
    await proc.handleMediaPlaylist(HEVC_URL, AD);
    await proc.handleMediaPlaylist(HEVC_URL, AD);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

    expect(switches).toEqual(['avc1.64002A,mp4a.40.2']);
    expect(handBacks).toBe(1);
    expect(flushes).toBe(0);
  });

  it('leaves an HEVC break served from an HEVC backup alone', async () => {
    const proc = makeProcessor(backupFetch(BACKUP, HEVC_MASTER));
    proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);
    expect(await proc.handleMediaPlaylist(HEVC_URL, AD)).toBe(BACKUP);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

    expect(flushes).toBe(0);
  });

  it('flushes after an HEVC pre-roll served from an AVC backup', async () => {
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);
    await proc.handleMediaPlaylist(HEVC_URL, AD);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

    expect(flushes).toBe(1);
  });
});

describe('ad break bookkeeping', () => {
  it('brackets the break with observer signals', async () => {
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    await proc.handleMediaPlaylist(AVC_URL, AD);
    await proc.handleMediaPlaylist(AVC_URL, CLEAN);
    expect(breakActiveCalls).toEqual([true, false]);
  });
});

describe('ad break with no backup available', () => {
  it('serves the original with ad segments marked, never a discontinuity', async () => {
    const proc = makeProcessor(deadFetch);
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    await proc.handleMediaPlaylist(AVC_URL, CLEAN);

    const out = await proc.handleMediaPlaylist(AVC_URL, AD);
    expect(proc.adSegments.has('ad1.ts')).toBe(true);
    expect(proc.adSegments.has('live1.ts')).toBe(false);
    expect(out).toContain('live1.ts');
    expect(out).not.toContain(DISCONTINUITY);
    expect(out).toContain('https://twitch.tv');

    expect(decisions()[1]!.data).toMatchObject({
      inAd: true,
      backup: { hit: false },
      markedSegments: 1,
    });
  });

  it('forgets the marked segments once the break ends', async () => {
    const proc = makeProcessor(deadFetch);
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    await proc.handleMediaPlaylist(AVC_URL, AD);
    await proc.handleMediaPlaylist(AVC_URL, CLEAN);
    expect([...proc.adSegments]).toEqual([]);
  });

  it('recovers the backup mid-break after an earlier miss (once backoff clears)', async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;

    let live = false;
    const flaky = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('gql')) {
        return live
          ? Promise.resolve(
              Response.json({ data: { streamPlaybackAccessToken: { signature: 's', value: 't' } } }),
            )
          : Promise.resolve(new Response('', { status: 500 }));
      }
      if (url.includes('usher')) return Promise.resolve(new Response(AVC_MASTER));
      return Promise.resolve(new Response(live ? BACKUP : '', { status: live ? 200 : 500 }));
    }) as unknown as typeof fetch;

    try {
      const proc = makeProcessor(flaky);
      proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);
      await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

      const p1 = await proc.handleMediaPlaylist(HEVC_URL, AD);
      expect(p1).toContain('live1.ts');

      now += 60_000;
      live = true;
      expect(await proc.handleMediaPlaylist(HEVC_URL, AD)).toBe(BACKUP);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('backoff', () => {
  it('does not re-hammer GQL after a failed acquisition within the backoff window', async () => {
    const attempts = mock(() => Promise.resolve(new Response('', { status: 500 })));
    const proc = makeProcessor(attempts as unknown as typeof fetch);
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);

    await proc.handleMediaPlaylist(AVC_URL, AD);
    const afterFirst = attempts.mock.calls.length;
    await proc.handleMediaPlaylist(AVC_URL, AD);

    expect(attempts.mock.calls.length).toBe(afterFirst);
    expect(traceEntries().some((e) => e.ev === 'backoff-skip')).toBe(true);
  });
});

describe('regressions', () => {
  it('keeps break state across a master re-fetch, so the HEVC flush still fires', async () => {
    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

    const inBreak = await proc.handleMediaPlaylist(HEVC_URL, AD);
    expect(inBreak).toContain('backup1.ts');

    proc.handleMasterPlaylist(MASTER_URL, HEVC_MASTER);

    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);
    expect(flushes).toBe(1);
  });

  it('latches the seam when ABR climbs into HEVC mid-break', async () => {
    const HEVC_MIXED = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002A"',
      AVC_URL,
      '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,FRAME-RATE=60.000,CODECS="hev1.1.6.L153.B0"',
      HEVC_URL,
    ].join('\n');

    const proc = makeProcessor(backupFetch());
    proc.handleMasterPlaylist(MASTER_URL, HEVC_MIXED);
    await proc.handleMediaPlaylist(AVC_URL, CLEAN);
    await proc.handleMediaPlaylist(AVC_URL, AD);
    await proc.handleMediaPlaylist(HEVC_URL, AD);
    await proc.handleMediaPlaylist(HEVC_URL, CLEAN);

    expect(flushes).toBe(1);
  });

  it('blanks low-latency ad hints, which the player fetches before any #EXTINF', async () => {
    const LL_AD = [
      '#EXTM3U',
      '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"',
      '#EXTINF:2.000,',
      'ad1.ts',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="https://cdn.example/adsquared/ad-part.ts"',
      '#EXT-X-TWITCH-PREFETCH:https://cdn.example/adsquared/ad-next.ts',
    ].join('\n');

    const proc = makeProcessor(deadFetch);
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    const out = await proc.handleMediaPlaylist(AVC_URL, LL_AD);

    expect(out).not.toContain('ad-next.ts');
    expect(out).not.toContain('ad-part.ts');
    expect(proc.adSegments.has('https://cdn.example/adsquared/ad-next.ts')).toBe(true);
  });

  it('catches an ad segment tagged ,live by its ad-CDN url', async () => {
    const SNEAKY = [
      '#EXTM3U',
      '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"',
      '#EXTINF:2.000,live',
      'https://cdn.example/adsquared/sneaky.ts',
      '#EXTINF:2.000,live',
      'https://video-edge.example/real.ts',
    ].join('\n');

    const proc = makeProcessor(deadFetch);
    proc.handleMasterPlaylist(MASTER_URL, AVC_MASTER);
    await proc.handleMediaPlaylist(AVC_URL, SNEAKY);

    expect(proc.adSegments.has('https://cdn.example/adsquared/sneaky.ts')).toBe(true);
    expect(proc.adSegments.has('https://video-edge.example/real.ts')).toBe(false);
  });
});

describe('markAdSegments', () => {
  it('marks non-live segments and leaves live ones alone', () => {
    const cache = new Set<string>();
    const { marked } = markAdSegments(AD, cache);
    expect(marked).toBe(1);
    expect([...cache]).toEqual(['ad1.ts']);
  });

  it('neutralizes every ad beacon URL and the verification scripts, nothing else', () => {
    const line =
      '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",DURATION=30.301,' +
      'X-TV-TWITCH-AD-UNMUTE-URL="https://a.example/u",X-TV-TWITCH-AD-POD-LENGTH="1",' +
      'X-TV-TWITCH-AD-TRACKING-START="https://b.example/s?x=1",X-TV-TWITCH-AD-CREATIVE-VIEW="http://c.example/v",' +
      'X-TV-TWITCH-AD-ADVERIFICATIONS="eyJWZXJpZmljYXRpb24iOltdfQ=="';
    const { text } = markAdSegments(AD.replace(/^#EXT-X-DATERANGE.*$/m, line), new Set<string>());
    expect(text).not.toContain('.example');
    expect(text).toContain('X-TV-TWITCH-AD-UNMUTE-URL="https://twitch.tv"');
    expect(text).toContain('X-TV-TWITCH-AD-TRACKING-START="https://twitch.tv"');
    expect(text).toContain('X-TV-TWITCH-AD-CREATIVE-VIEW="https://twitch.tv"');
    expect(text).toContain('X-TV-TWITCH-AD-POD-LENGTH="1",');
    expect(text).toContain('X-TV-TWITCH-AD-ADVERIFICATIONS=""');
  });

  it('returns the original string when there is nothing to rewrite', () => {
    const cache = new Set<string>();
    const { text, marked } = markAdSegments(CLEAN, cache);
    expect(text).toBe(CLEAN);
    expect(marked).toBe(0);
  });
});
