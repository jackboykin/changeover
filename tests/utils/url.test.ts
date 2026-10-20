import { describe, it, expect } from 'bun:test';
import { channelFromUsherUrl, classifyHlsUrl } from '../../src/utils/url';

describe('classifyHlsUrl', () => {
  it('a usher channel URL is a master', () => {
    expect(classifyHlsUrl('https://usher.ttvnw.net/api/channel/hls/streamer.m3u8')).toEqual({
      isHls: true,
      isMaster: true,
    });
  });

  it('any other .m3u8 is a media playlist', () => {
    expect(classifyHlsUrl('https://video-edge.example.com/v1/playlist/media-123.m3u8')).toEqual({
      isHls: true,
      isMaster: false,
    });
  });

  it('picture-by-picture is never a master', () => {
    expect(
      classifyHlsUrl('https://usher.ttvnw.net/api/channel/hls/picture-by-picture/streamer.m3u8'),
    ).toEqual({
      isHls: true,
      isMaster: false,
    });
    expect(classifyHlsUrl('https://usher.ttvnw.net/api/channel/hls/picture-by-picture/streamer')).toEqual({
      isHls: false,
      isMaster: false,
    });
  });

  it('a non-HLS URL is neither', () => {
    expect(classifyHlsUrl('https://example.com/page.html')).toEqual({ isHls: false, isMaster: false });
  });
});

describe('channelFromUsherUrl', () => {
  it('reads the login from v1 and v2 usher paths', () => {
    expect(channelFromUsherUrl('https://usher.ttvnw.net/api/channel/hls/streamer.m3u8?sig=x')).toBe(
      'streamer',
    );
    expect(channelFromUsherUrl('https://usher.ttvnw.net/api/v2/channel/hls/some_one.m3u8')).toBe('some_one');
  });

  it('is null for anything else', () => {
    expect(channelFromUsherUrl('https://video-edge.example.com/1080p60.m3u8')).toBeNull();
  });
});
