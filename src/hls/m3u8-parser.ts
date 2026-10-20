import type { StreamVariant } from '../types';

const LF = 10;
const CR = 13;
const SPACE = 32;
const QUOTE = 34;
const COMMA = 44;
const EQ = 61;

export function splitLines(str: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === LF) {
      result.push(str.substring(start, i));
      start = i + 1;
    } else if (ch === CR) {
      result.push(str.substring(start, i));
      if (i + 1 < str.length && str.charCodeAt(i + 1) === LF) i++;
      start = i + 1;
    }
  }
  result.push(str.substring(start));
  return result;
}

export const MEDIA_SEQUENCE_TAG = '#EXT-X-MEDIA-SEQUENCE:';
export const LIVE_SEQUENCE_TAG = '#EXT-X-TWITCH-LIVE-SEQUENCE:';

// Header only: a stitched playlist repeats LIVE-SEQUENCE inline, after its ads.
export function headerInt(text: string, tag: string): number | null {
  const idx = text.indexOf(tag);
  const firstSegment = text.indexOf('#EXTINF');
  if (idx === -1 || (firstSegment !== -1 && idx > firstSegment)) return null;
  const n = parseInt(text.substring(idx + tag.length, idx + tag.length + 20), 10);
  return Number.isNaN(n) ? null : n;
}

export function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  const len = line.length;

  while (i < len) {
    while (i < len && (line.charCodeAt(i) === COMMA || line.charCodeAt(i) === SPACE)) i++;
    if (i >= len) break;

    const keyStart = i;
    while (i < len && line.charCodeAt(i) !== EQ) i++;
    if (i >= len) break;
    const key = line.substring(keyStart, i);
    i++;

    if (i < len && line.charCodeAt(i) === QUOTE) {
      i++;
      const valStart = i;
      while (i < len && line.charCodeAt(i) !== QUOTE) i++;
      attrs[key] = line.substring(valStart, i);
      if (i < len) i++;
    } else {
      const valStart = i;
      while (i < len && line.charCodeAt(i) !== COMMA) i++;
      attrs[key] = line.substring(valStart, i);
    }
  }

  return attrs;
}

export function parseMasterPlaylist(text: string): StreamVariant[] {
  const lines = splitLines(text);
  const variants: StreamVariant[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-STREAM-INF') && lines[i + 1]!.includes('.m3u8')) {
      const attrs = parseAttributes(line.substring(line.indexOf(':') + 1));
      const resolution = attrs['RESOLUTION'] ?? '';
      if (resolution) {
        const parts = resolution.split('x');
        const w = Number(parts[0]);
        const h = Number(parts[1]);
        if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
        const codecs = attrs['CODECS'] ?? '';
        variants.push({
          url: lines[i + 1]!,
          resolution,
          width: w,
          height: h,
          frameRate: Number(attrs['FRAME-RATE'] ?? 0),
          codecs,
          isHEVC: codecs.startsWith('hev') || codecs.startsWith('hvc'),
        });
      }
    }
  }

  return variants;
}
