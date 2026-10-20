export function normalizeUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

export function urlTail(url: string, chars = 48): string {
  const path = url.split('?')[0]!;
  return path.substring(Math.max(0, path.length - chars));
}

export function classifyHlsUrl(url: string): { isHls: boolean; isMaster: boolean } {
  const isMaster = url.includes('/channel/hls/') && !url.includes('picture-by-picture');
  const isHls = isMaster || url.includes('.m3u8');
  return { isHls, isMaster };
}

const USHER_CHANNEL = /\/channel\/hls\/([^/.]+)\.m3u8/;

export function channelFromUsherUrl(url: string): string | null {
  return USHER_CHANNEL.exec(url)?.[1] ?? null;
}
