import type { StreamVariant } from '../types';

export const MEDIA_SEQUENCE_TAG = '#EXT-X-MEDIA-SEQUENCE:';
export const LIVE_SEQUENCE_TAG = '#EXT-X-TWITCH-LIVE-SEQUENCE:';

// Header only: a stitched playlist repeats LIVE-SEQUENCE inline, after its ads.
export function headerInt(text: string, tag: string): number | null {
  const idx = text.indexOf(tag);
  const firstSegment = text.indexOf('#EXTINF');
  if (idx === -1 || (firstSegment !== -1 && idx > firstSegment)) return null;
  const n = parseInt(text.slice(idx + tag.length, idx + tag.length + 20), 10);
  return Number.isNaN(n) ? null : n;
}

const AUDIO_CODEC = /^(mp4a|ac-3|ec-3|opus|flac)/u;

// The video sample entry, such as avc1 or hev1.
export function videoCodec(codecs: string): string {
  const video = codecs
    .split(',')
    .map((c) => c.trim())
    .find((c) => !AUDIO_CODEC.test(c));
  return video?.split('.')[0] ?? '';
}

// A rendition's container and video codec. fMP4 names an init segment before its first media
// segment; MPEG-TS has none. Changing either inside one rendition is a seam the player can't see.
export function mediaFormat(playlist: string, codecs: string): string {
  const map = playlist.indexOf('#EXT-X-MAP');
  const first = playlist.indexOf('#EXTINF');
  const fmp4 = map !== -1 && (first === -1 || map < first);
  return `${fmp4 ? 'fmp4' : 'ts'}/${videoCodec(codecs)}`;
}

const ATTRIBUTE = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/gu;

export function parseAttributes(list: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, key, quoted, bare] of list.matchAll(ATTRIBUTE)) attrs[key!] = quoted ?? bare!;
  return attrs;
}

const STREAM_INF_TAG = '#EXT-X-STREAM-INF:';
const RESOLUTION = /^(\d+)x(\d+)$/u;

// Video renditions only, with their URLs resolved against the master's.
export function parseMasterPlaylist(text: string, masterUrl: string): StreamVariant[] {
  const lines = text.split(/\r?\n/u);
  const variants: StreamVariant[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const uri = lines[i + 1]!;
    if (!line.startsWith(STREAM_INF_TAG) || !uri.includes('.m3u8')) continue;
    const attrs = parseAttributes(line.slice(STREAM_INF_TAG.length));
    const size = RESOLUTION.exec(attrs['RESOLUTION'] ?? '');
    if (!size) continue;
    variants.push({
      url: new URL(uri, masterUrl).href,
      resolution: size[0],
      width: Number(size[1]),
      height: Number(size[2]),
      frameRate: Number(attrs['FRAME-RATE'] ?? 0),
      codecs: attrs['CODECS'] ?? '',
    });
  }
  return variants;
}
