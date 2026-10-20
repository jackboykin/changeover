import { describe, it, expect } from 'bun:test';
import { splitLines, parseAttributes, parseMasterPlaylist } from '../../src/hls/m3u8-parser';

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

  it('detects HEVC variants', () => {
    const variants = parseMasterPlaylist(sampleMaster);
    expect(variants[0]!.isHEVC).toBe(false);
    expect(variants[1]!.isHEVC).toBe(false);
    expect(variants[2]!.isHEVC).toBe(true);
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
