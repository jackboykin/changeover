export function normalizeUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

// A URL cut to its host and file type, which tells playlists and segments apart in a trace
// without the signed path and query that name the viewing session.
export function urlShape(url: string): string {
  const m = /^\w+:\/\/([^/?#]+)[^?#]*?(\.\w+)?(?:[?#].*)?$/.exec(url);
  return m ? `${m[1]}/…${m[2] ?? ''}` : '…';
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
