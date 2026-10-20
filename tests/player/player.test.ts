import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { IVSQuality } from '../../src/types';

const { hardFlush, setFreshPathMint } = await import('../../src/player/player');
const { clearTrace, traceEntries } = await import('../../src/trace');

const ivsLoad = mock((_url?: string) => {});
const ivsPlay = mock(() => {});
const setQuality = mock((_q: IVSQuality) => {});
const setAutoQualityMode = mock((_on: boolean) => {});
const CURRENT_PATH = 'https://usher.ttvnw.net/api/channel/hls/c.m3u8?sig=old&token=old';
const FRESH_PATH = 'https://usher.ttvnw.net/api/channel/hls/c.m3u8?sig=new&token=new';

interface FakeQualityState {
  current: IVSQuality;
  auto: boolean;
}

function installFakeDom(
  readyState: number | (() => number),
  quality?: FakeQualityState,
  path: string = CURRENT_PATH,
): { video: { readyState: number }; ivs: Record<string, unknown> } {
  const ivs: Record<string, unknown> = { load: ivsLoad, getPath: () => path, play: ivsPlay };
  if (quality) {
    ivs['getQuality'] = () => quality.current;
    ivs['isAutoQualityMode'] = () => quality.auto;
    ivs['setQuality'] = setQuality;
    ivs['setAutoQualityMode'] = setAutoQualityMode;
  }
  const fiber = { memoizedProps: { mediaPlayerInstance: ivs }, return: null, child: null, sibling: null };
  const parent: Record<string, unknown> = { __reactFiber$test: fiber, parentElement: null };
  const video: Record<string, unknown> = { parentElement: parent, currentTime: 42, paused: false };
  if (typeof readyState === 'function') Object.defineProperty(video, 'readyState', { get: readyState });
  else video['readyState'] = readyState;
  (globalThis as unknown as { document: unknown }).document = {
    querySelector: (sel: string) => (sel === 'video' ? video : null),
  };
  return { video: video as unknown as { readyState: number }, ivs };
}

describe('hardFlush', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realDocument = globalThis.document;

  beforeEach(() => {
    clearTrace();
    ivsLoad.mockClear();
    ivsPlay.mockClear();
    setQuality.mockClear();
    setAutoQualityMode.mockClear();
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout;
  });

  afterEach(() => {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (globalThis as unknown as { document: unknown }).document = realDocument;
    setFreshPathMint(() => Promise.resolve(null));
  });

  it('reloads the player own path first, without minting a new session', async () => {
    installFakeDom(4);
    const mint = mock((_ch: string) => Promise.resolve(FRESH_PATH));
    setFreshPathMint(mint);

    expect(await hardFlush()).toBe(true);

    expect(mint).not.toHaveBeenCalled();
    expect(ivsLoad).toHaveBeenCalledTimes(1);
    expect(ivsLoad).toHaveBeenCalledWith(CURRENT_PATH);
    expect(ivsPlay).toHaveBeenCalledTimes(1);
  });

  it('mints a retry for the channel in the player own path, not the last master seen', async () => {
    installFakeDom(4, undefined, 'https://usher.ttvnw.net/api/channel/hls/streamerA.m3u8?sig=x');
    const seen: string[] = [];
    setFreshPathMint((ch) => {
      seen.push(ch);
      return Promise.resolve(`https://usher.ttvnw.net/api/channel/hls/${ch}.m3u8?sig=new`);
    });

    expect(await hardFlush(1)).toBe(true);

    expect(seen).toEqual(['streamerA']);
    expect(ivsLoad).toHaveBeenCalledWith('https://usher.ttvnw.net/api/channel/hls/streamerA.m3u8?sig=new');
  });

  it('never mints blind when the player path carries no channel', async () => {
    installFakeDom(4, undefined, 'blob:https://www.twitch.tv/6f3c1e');
    const mint = mock((_ch: string) => Promise.resolve(FRESH_PATH));
    setFreshPathMint(mint);

    expect(await hardFlush(1)).toBe(true);

    expect(mint).not.toHaveBeenCalled();
    expect(ivsLoad).toHaveBeenCalledWith('blob:https://www.twitch.tv/6f3c1e');
    expect(traceEntries().find((e) => e.ev === 'mint')?.data?.['flavor']).toBe('NO-CHANNEL');
  });

  it('falls back to the current path when the retry mint fails', async () => {
    installFakeDom(4);
    setFreshPathMint(() => Promise.resolve(null));

    expect(await hardFlush(1)).toBe(true);

    expect(ivsLoad).toHaveBeenCalledWith(CURRENT_PATH);
    const reload = traceEntries().find((e) => e.cat === 'player' && e.ev === 'reload');
    expect(reload?.data?.['action']).toBe('ivs-load');
  });

  it('verifies the flush took and retries exactly once on a dead element', async () => {
    installFakeDom(0);
    setFreshPathMint(() => Promise.resolve(FRESH_PATH));

    await hardFlush();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(ivsLoad.mock.calls.map((c) => c[0])).toEqual([CURRENT_PATH, FRESH_PATH]);
    const verdicts = traceEntries()
      .filter((e) => e.cat === 'player' && e.ev === 'flush-verify')
      .map((e) => e.data?.['action']);
    expect(verdicts).toEqual(['DEAD', 'DEAD']);
  });

  it('waits out a cold decoder init and pins quality only at readiness', async () => {
    let polls = 0;
    const q1440: IVSQuality = { name: '1440p60' };
    installFakeDom(() => (++polls >= 15 ? 4 : 1), { current: q1440, auto: false });
    setFreshPathMint(() => Promise.resolve(FRESH_PATH));

    await hardFlush();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(setQuality).toHaveBeenCalledTimes(1);
    expect(setQuality.mock.calls[0]![0]).toBe(q1440);
    const verify = traceEntries().filter((e) => e.ev === 'flush-verify');
    expect(verify.map((e) => e.data?.['action'])).toEqual(['ok']);
    expect(verify[0]?.data?.['ms']).toBe(7500);
    expect(ivsLoad).toHaveBeenCalledTimes(1);
  });

  it('treats a session stuck below readiness as dead — never a blind quality pin', async () => {
    installFakeDom(1, { current: { name: '1440p60' }, auto: false });
    setFreshPathMint(() => Promise.resolve(FRESH_PATH));

    await hardFlush();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(setQuality).not.toHaveBeenCalled();
    const verdicts = traceEntries()
      .filter((e) => e.ev === 'flush-verify')
      .map((e) => e.data?.['action']);
    expect(verdicts).toEqual(['DEAD', 'DEAD']);
    expect(ivsLoad).toHaveBeenCalledTimes(2);
  });

  it("retries with attempt 0's quality snapshot instead of re-reading the dead session", async () => {
    const q1440: IVSQuality = { name: '1440p60' };
    let rsPolls = 0;
    const { ivs } = installFakeDom(() => (++rsPolls > 24 ? 4 : 0), { current: q1440, auto: false });
    let reads = 0;
    ivs['getQuality'] = () => {
      reads++;
      if (reads > 1) throw new Error('dead session');
      return q1440;
    };
    setFreshPathMint(() => Promise.resolve(FRESH_PATH));

    await hardFlush();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(reads).toBe(1);
    expect(setQuality).toHaveBeenCalledTimes(1);
    expect(setQuality.mock.calls[0]![0]).toBe(q1440);
    const verdicts = traceEntries()
      .filter((e) => e.ev === 'flush-verify')
      .map((e) => e.data?.['action']);
    expect(verdicts).toEqual(['DEAD', 'ok']);
  });

  it('restores auto quality mode instead of pinning when the user was on auto', async () => {
    installFakeDom(4, { current: { name: '720p60' }, auto: true });
    setFreshPathMint(() => Promise.resolve(FRESH_PATH));

    await hardFlush();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(setAutoQualityMode).toHaveBeenCalledWith(true);
    expect(setQuality).not.toHaveBeenCalled();
  });

  it('resolves false when IVS cannot be found, so callers can fall back', async () => {
    (globalThis as unknown as { document: unknown }).document = {
      querySelector: () => null,
    };
    expect(await hardFlush()).toBe(false);
    expect(ivsLoad).not.toHaveBeenCalled();
  });
});
