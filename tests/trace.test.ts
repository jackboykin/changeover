import { describe, it, expect, beforeEach } from 'bun:test';
import { trace, traceEntries, clearTrace, digestPlaylist, scrubPlaylist } from '../src/trace';

describe('trace ring buffer', () => {
  beforeEach(() => clearTrace());

  it('records entries in order with monotonic seq', () => {
    trace('a', 'one', { x: 1 });
    trace('a', 'two');
    const entries = traceEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.cat).toBe('a');
    expect(entries[0]!.ev).toBe('one');
    expect(entries[0]!.data).toEqual({ x: 1 });
    expect(entries[1]!.data).toBeUndefined();
    expect(entries[1]!.seq).toBe(entries[0]!.seq + 1);
  });

  it('evicts oldest-first once full and keeps order across the wrap', () => {
    const MAX = 700; // FREQUENT_MAX in src/trace.ts
    for (let i = 0; i < MAX + 5; i++) trace('poll', 'decision', { i });
    const entries = traceEntries();
    expect(entries).toHaveLength(MAX);
    expect(entries[0]!.data).toEqual({ i: 5 });
    expect(entries[MAX - 1]!.data).toEqual({ i: MAX + 4 });
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.seq).toBeGreaterThan(entries[i - 1]!.seq);
    }
  });
});

describe('trace ring tiers', () => {
  beforeEach(() => clearTrace());

  it('a poll flood cannot evict rare events', () => {
    trace('break', 'start', { breakId: 1 });
    trace('player', 'reload', { action: 'ivs-load' });
    trace('break', 'end', { breakId: 1 });

    for (let i = 0; i < 5000; i++) trace('poll', 'decision', { i });
    for (let i = 0; i < 5000; i++) trace('sample', 'tick', { i });

    const cats = traceEntries().map((e) => e.cat);
    expect(cats.filter((c) => c === 'break')).toHaveLength(2);
    expect(cats.filter((c) => c === 'player')).toHaveLength(1);
  });

  it('merged entries interleave in seq order across both rings', () => {
    trace('break', 'start');
    trace('poll', 'decision');
    trace('break', 'end');
    trace('sample', 'tick');

    expect(traceEntries().map((e) => e.cat)).toEqual(['break', 'poll', 'break', 'sample']);
  });
});

describe('digestPlaylist', () => {
  it('fingerprints segments, hints, and discontinuities', () => {
    const m3u8 = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:1234',
      '#EXT-X-DATERANGE:CLASS="twitch-stitched-ad"',
      '#EXTINF:2.000,live',
      'live1.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:2.001,',
      'ad1.ts',
      '#EXT-X-PART:DURATION=0.5,URI="part1.ts"',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part2.ts"',
      '#EXT-X-TWITCH-PREFETCH:https://example.com/next.ts',
    ].join('\n');
    expect(digestPlaylist(m3u8)).toEqual({
      bytes: m3u8.length,
      segments: 2,
      live: 1,
      stitched: true,
      maf: false,
      prefetch: 1,
      preloadHints: 1,
      parts: 1,
      discontinuities: 1,
      mediaSeq: 1234,
    });
  });
});

describe('scrubPlaylist', () => {
  const raw = [
    '#EXTM3U',
    '#EXT-X-DATERANGE:ID="playlist-session-1792509673",CLASS="twitch-session",X-TV-TWITCH-SESSIONID="4269315076774651013"',
    '#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",X-TV-TWITCH-STREAM-SOURCE="live"',
    '#EXT-X-DATERANGE:ID="trigger-1",CLASS="twitch-trigger",X-TV-TWITCH-TRIGGER-URL="https://use22.playlist.ttvnw.net/trigger/CvkHyYQX7Inst"',
    '#EXT-X-MAP:URI="https://e8d2.hls.ttvnw.net/v1/segment/Cv8CGAATwmh.mp4"',
    '#EXTINF:2.000,live',
    'https://e8d2.hls.ttvnw.net/v1/segment/CpIDlHMwmZZ3Qx.mp4?dna=CoQBHeVh',
  ].join('\n');
  const out = scrubPlaylist(raw);

  it('cuts session ids, tokens, and signed URLs', () => {
    expect(out).not.toContain('4269315076774651013');
    expect(out).not.toContain('CvkHyYQX7Inst');
    expect(out).not.toContain('CpIDlHMwmZZ3Qx');
    expect(out).not.toContain('dna=');
  });

  it('keeps the structure a log is read for: tags, classes, short values, and file types', () => {
    expect(out).toContain('CLASS="twitch-session"');
    expect(out).toContain('X-TV-TWITCH-STREAM-SOURCE="live"');
    expect(out).toContain('#EXT-X-MAP:URI="e8d2.hls.ttvnw.net/….mp4"');
    expect(out).toContain('#EXTINF:2.000,live\ne8d2.hls.ttvnw.net/….mp4');
  });
});
