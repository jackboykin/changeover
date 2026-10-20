import { describe, it, expect } from 'bun:test';
import {
  splitLines,
  parseAttributes,
  parseMasterPlaylist,
  videoCodec,
  mediaFormat,
} from '../../src/hls/m3u8-parser';

describe('splitLines', () => {
  it('splits on newlines', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('handles CRLF', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseAttributes', () => {
  it('parses key-value pairs', () => {
    const result = parseAttributes('BANDWIDTH=6000000,RESOLUTION=1920x1080');
    expect(result['BANDWIDTH']).toBe('6000000');
    expect(result['RESOLUTION']).toBe('1920x1080');
  });

  it('parses quoted values', () => {
    const result = parseAttributes('CODECS="avc1.4D401F,mp4a.40.2"');
    expect(result['CODECS']).toBe('avc1.4D401F,mp4a.40.2');
  });
});

describe('parseMasterPlaylist', () => {
  const sampleMaster = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30.000',
    'https://video.twitch.tv/v1/1080p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4D401E,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30.000',
    'https://video.twitch.tv/v1/720p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1500000,CODECS="hev1.1.6.L120,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30.000',
    'https://video.twitch.tv/v1/1080p30_hevc.m3u8',
  ].join('\n');

  it('parses all variants', () => {
    const variants = parseMasterPlaylist(sampleMaster);
    expect(variants).toHaveLength(3);
  });

  it('extracts resolution correctly', () => {
    const variants = parseMasterPlaylist(sampleMaster);
    expect(variants[0]!.resolution).toBe('1920x1080');
    expect(variants[0]!.width).toBe(1920);
    expect(variants[0]!.height).toBe(1080);
  });

  it('extracts codecs', () => {
    const variants = parseMasterPlaylist(sampleMaster);
    expect(variants[0]!.codecs).toBe('avc1.4D401F,mp4a.40.2');
  });

  it('extracts URLs', () => {
    const variants = parseMasterPlaylist(sampleMaster);
    expect(variants[0]!.url).toBe('https://video.twitch.tv/v1/1080p30.m3u8');
    expect(variants[1]!.url).toBe('https://video.twitch.tv/v1/720p30.m3u8');
  });

  it('skips variants with malformed RESOLUTION', () => {
    const malformed = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="avc1.4D401F",RESOLUTION=badvalue',
      'https://video.twitch.tv/v1/bad.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4D401E",RESOLUTION=1280x720,FRAME-RATE=30.000',
      'https://video.twitch.tv/v1/720p30.m3u8',
    ].join('\n');
    const variants = parseMasterPlaylist(malformed);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.resolution).toBe('1280x720');
  });
});

describe('videoCodec', () => {
  it('names the video sample entry, wherever it sits in CODECS', () => {
    expect(videoCodec('avc1.4D401F,mp4a.40.2')).toBe('avc1');
    expect(videoCodec('mp4a.40.2, hev1.1.6.L150.90')).toBe('hev1');
    expect(videoCodec('av01.0.08M.08,opus')).toBe('av01');
  });

  it('is empty for an audio-only rendition', () => {
    expect(videoCodec('mp4a.40.2')).toBe('');
  });
});

describe('mediaFormat', () => {
  const ts = ['#EXTM3U', '#EXTINF:2.000,live', 'seg.ts'].join('\n');
  const fmp4 = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:2.000,live', 'seg.mp4'].join('\n');

  it('reads fMP4 from an init segment ahead of the media and pairs it with the codec', () => {
    expect(mediaFormat(fmp4, 'hev1.1.6.L150,mp4a.40.2')).toBe('fmp4/hev1');
    expect(mediaFormat(ts, 'avc1.64002A,mp4a.40.2')).toBe('ts/avc1');
  });

  it('reads TS when the only init segment belongs to a later stitched ad', () => {
    const tsWithAd = [
      ts,
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-MAP:URI="ad-init.mp4"',
      '#EXTINF:2.000,',
      'ad.mp4',
    ].join('\n');
    expect(mediaFormat(tsWithAd, 'avc1.64002A')).toBe('ts/avc1');
  });

  it('tells a codec change apart within one container', () => {
    expect(mediaFormat(fmp4, 'av01.0.08M.08')).not.toBe(mediaFormat(fmp4, 'hev1.1.6.L150'));
  });
});
