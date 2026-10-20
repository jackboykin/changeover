import type { GQLHeaders, ChannelStreamInfo, StreamVariant } from '../types';
import { AD_SIGNIFIER, AD_SEGMENT_URL_PATTERNS } from '../utils/constants';
import {
  parseMasterPlaylist,
  splitLines,
  headerInt,
  MEDIA_SEQUENCE_TAG,
  LIVE_SEQUENCE_TAG,
  mediaFormat,
  videoCodec,
} from './m3u8-parser';
import { BackupStreamManager, mintUsherUrl, SITE_FLAVOR } from './backup-stream';
import { channelFromUsherUrl, normalizeUrl, urlTail } from '../utils/url';
import { hardFlush, setFreshPathMint } from '../player/player';
import { setBreakActive } from '../player/observer';
import { trace, digestPlaylist, captureBody, recordBreakSummary } from '../trace';

const STREAM_INFO_TTL_MS = 15 * 60_000;
const STREAM_INFO_MAX_ENTRIES = 12;
const AD_REPLACEMENT_URL = 'https://twitch.tv';
const SEGMENT_CACHE_MAX_ENTRIES = 500;

export class SegmentCache {
  private adSegments = new Set<string>();

  isAdSegment(url: string): boolean {
    return this.adSegments.has(url);
  }

  markAdSegment(url: string): void {
    // Re-adding moves a URL to the back, so the cap evicts the oldest.
    this.adSegments.delete(url);
    this.adSegments.add(url);
    if (this.adSegments.size > SEGMENT_CACHE_MAX_ENTRIES) {
      this.adSegments.delete(this.adSegments.values().next().value!);
    }
  }

  getAdSegmentUrls(): string[] {
    return [...this.adSegments];
  }

  clear(): void {
    this.adSegments.clear();
  }
}

const PREFETCH_TAG = '#EXT-X-TWITCH-PREFETCH:';
const PRELOAD_HINT_TAG = '#EXT-X-PRELOAD-HINT:';
const PART_TAG = '#EXT-X-PART:';

const TRACKING_URL_RE = /(X-TV-TWITCH-AD-[A-Z0-9-]+=")https?:\/\/[^"]*/g;
// Emptied rather than removed: an empty list makes the player skip verification setup.
const VERIFICATIONS_RE = /(X-TV-TWITCH-AD-ADVERIFICATIONS=")[^"]*/;

function isAdSegmentUrl(url: string): boolean {
  for (const pattern of AD_SEGMENT_URL_PATTERNS) {
    if (url.includes(pattern)) return true;
  }
  return false;
}

function extractUriAttr(line: string): string {
  const marker = 'URI="';
  const idx = line.indexOf(marker);
  if (idx === -1) return '';
  const start = idx + marker.length;
  const end = line.indexOf('"', start);
  return end === -1 ? '' : line.substring(start, end);
}

// Live segments are tagged ,live and never come from an ad CDN; everything else is an ad.
// Low-latency hints are blanked, since the player fetches them before reading any #EXTINF.
export function markAdSegments(text: string, cache: SegmentCache): { text: string; marked: number } {
  const hasTracking = text.includes('X-TV-TWITCH-AD-');
  const lines = splitLines(text);
  const lastIdx = lines.length - 1;
  let marked = 0;
  let changed = hasTracking;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;

    if (hasTracking && line.startsWith('#EXT-X-DATERANGE')) {
      line = line.replace(TRACKING_URL_RE, '$1' + AD_REPLACEMENT_URL).replace(VERIFICATIONS_RE, '$1');
      lines[i] = line;
    }

    if (i < lastIdx && line.startsWith('#EXTINF')) {
      const segUrl = lines[i + 1]!;
      if (!line.includes(',live') || isAdSegmentUrl(segUrl)) {
        cache.markAdSegment(segUrl);
        marked++;
      }
    } else if (line.startsWith(PREFETCH_TAG) || line.startsWith(PRELOAD_HINT_TAG)) {
      const hintUrl = line.startsWith(PREFETCH_TAG)
        ? line.substring(PREFETCH_TAG.length).trim()
        : extractUriAttr(line);
      if (hintUrl) cache.markAdSegment(hintUrl);
      lines[i] = '';
      changed = true;
    } else if (line.startsWith(PART_TAG)) {
      const uri = extractUriAttr(line);
      if (uri && (cache.isAdSegment(uri) || isAdSegmentUrl(uri))) {
        cache.markAdSegment(uri);
        lines[i] = '';
        changed = true;
      }
    }
  }

  return { text: changed ? lines.join('\n') : text, marked };
}

// The player keys on MEDIA-SEQUENCE, which runs ahead of LIVE-SEQUENCE by every ad a session
// has stitched. Every session shares live numbers, so serving only those lines up the swap to
// the backup and back.
export function liveNumbered(text: string): string {
  const media = headerInt(text, MEDIA_SEQUENCE_TAG);
  const live = headerInt(text, LIVE_SEQUENCE_TAG);
  if (media === null || live === null || media === live) return text;
  return text.replace(MEDIA_SEQUENCE_TAG + media, MEDIA_SEQUENCE_TAG + live);
}

let nextBreakId = 1;

export class M3U8Processor {
  private streamInfos = new Map<string, ChannelStreamInfo>();
  private streamByUrl = new Map<string, ChannelStreamInfo>();
  private segmentCache = new SegmentCache();
  private backupManager: BackupStreamManager;
  private passedThrough = new Set<string>();
  constructor(getHeaders: () => GQLHeaders, realFetch: typeof fetch) {
    this.backupManager = new BackupStreamManager(getHeaders, realFetch);

    setFreshPathMint(async (channelName: string) => {
      const info = this.streamInfos.get(channelName);
      if (!info) {
        trace('player', 'mint', { flavor: 'NO-STREAM-INFO', channel: channelName });
        return null;
      }
      // The full ladder the player already runs: the android floor would strand a 1440p viewer at 360p.
      const url = await mintUsherUrl(info, getHeaders(), realFetch, SITE_FLAVOR).catch(() => null);
      trace('player', 'mint', { flavor: url ? 'site' : 'FAILED', channel: channelName });
      return url;
    });
  }

  isKnownAdSegment(url: string): boolean {
    return this.segmentCache.isAdSegment(url);
  }

  getAdSegmentUrls(): string[] {
    return this.segmentCache.getAdSegmentUrls();
  }

  handleMasterPlaylist(url: string, text: string): string {
    const masterUrl = normalizeUrl(url);
    const channelName = channelFromUsherUrl(masterUrl);
    if (!channelName) {
      trace('master', 'unmatched', { url: urlTail(masterUrl) });
      return text;
    }

    this.evictStaleStreams();

    const prev = this.streamInfos.get(channelName);
    if (prev) {
      for (const variantUrl of Object.keys(prev.variants)) this.streamByUrl.delete(variantUrl);
    }

    const qIdx = masterUrl.indexOf('?');
    const info: ChannelStreamInfo = {
      channelName,
      lastSeenAt: Date.now(),
      isUsherV2: masterUrl.includes('/api/v2/'),
      usherParams: qIdx >= 0 ? masterUrl.substring(qIdx) : '',
      variants: {},
      // Kept across a master re-fetch (token refresh, our own flush), or a seamed break never flushes.
      break: prev?.break ?? null,
    };
    this.streamInfos.set(channelName, info);

    for (const variant of parseMasterPlaylist(text)) {
      const resolved = new URL(variant.url, masterUrl).href;
      variant.url = resolved;
      info.variants[resolved] = variant;
      this.streamByUrl.set(resolved, info);
    }

    trace('master', 'handled', {
      channel: channelName,
      variants: Object.keys(info.variants).length,
      codecs: [...new Set(Object.values(info.variants).map((v) => videoCodec(v.codecs)))].join(','),
      isUsherV2: info.isUsherV2,
    });

    return text;
  }

  async handleMediaPlaylist(url: string, text: string): Promise<string> {
    const mediaUrl = normalizeUrl(url);
    const info = this.streamByUrl.get(mediaUrl);
    if (!info) {
      this.notePassthrough(mediaUrl);
      return text;
    }
    info.lastSeenAt = Date.now();

    return this.process(mediaUrl, text, info);
  }

  private async process(url: string, text: string, info: ChannelStreamInfo): Promise<string> {
    const variant = info.variants[url];
    const rawDigest = digestPlaylist(text);
    const inAd = text.includes(AD_SIGNIFIER);

    const opened = inAd && !info.break;
    if (opened) this.openBreak(info, variant, url, text);

    if (!inAd && info.break) this.closeBreak(info, url, text);

    let served = text;
    let backupHit = false;
    let backupMs = 0;

    if (inAd && variant) {
      const startedAt = Date.now();
      const backup = await this.backupManager.poll(info, variant);
      backupMs = Date.now() - startedAt;
      backupHit = backup !== null;
      if (backup !== null) {
        served = backup;
        // Latched: one poll served in another format than the rendition's own is a seam.
        const backupCodecs = this.backupManager.servedCodecs(info.channelName) ?? '';
        if (mediaFormat(backup, backupCodecs) !== mediaFormat(text, variant.codecs)) info.break!.seam = true;
      }
    }

    let marked = 0;
    if (inAd && !backupHit) {
      const result = markAdSegments(served, this.segmentCache);
      served = result.text;
      marked = result.marked;
    }

    served = liveNumbered(served);
    if (opened && backupHit) captureBody('break-served', urlTail(url, 32), served);

    const bt = info.break;
    if (bt) {
      bt.polls++;
      if (backupHit) bt.backupHits++;
      else bt.backupMisses++;
    }
    trace('poll', 'decision', {
      breakId: bt?.id ?? null,
      channel: info.channelName,
      url: urlTail(url, 32),
      codec: variant?.codecs ?? null,
      digest: rawDigest,
      inAd,
      backup: inAd ? { hit: backupHit, ms: backupMs } : null,
      served: backupHit ? digestPlaylist(served) : null,
      markedSegments: marked,
    });

    return served;
  }

  private openBreak(
    info: ChannelStreamInfo,
    variant: StreamVariant | undefined,
    url: string,
    raw: string,
  ): void {
    const codec = variant?.codecs ?? 'unknown';
    info.break = {
      id: nextBreakId++,
      startedAt: Date.now(),
      codec,
      seam: false,
      polls: 0,
      backupHits: 0,
      backupMisses: 0,
    };
    trace('break', 'start', { breakId: info.break.id, channel: info.channelName, codec });
    captureBody('break-open', urlTail(url, 32), raw);
    setBreakActive(true);
  }

  private closeBreak(info: ChannelStreamInfo, url: string, raw: string): void {
    const { id, startedAt, ...counts } = info.break!;
    info.break = null;
    this.backupManager.endBreak(info.channelName);
    this.segmentCache.clear();

    // A seam leaves the player's audio timeline out of sync on the return; a reload resets it.
    // Twitch serves HEVC as fMP4 and AVC as MPEG-TS, so an AVC backup in an HEVC rendition is one.
    if (counts.seam) void hardFlush();

    const now = Date.now();
    const summary = {
      breakId: id,
      channel: info.channelName,
      startedAt,
      endedAt: now,
      durationMs: now - startedAt,
      ...counts,
    };
    trace('break', 'end', summary);
    recordBreakSummary(summary);
    captureBody('break-close', urlTail(url, 32), raw);
    setBreakActive(false);
  }

  private notePassthrough(url: string): void {
    if (this.passedThrough.has(url)) return;
    if (this.passedThrough.size >= 64) this.passedThrough.clear();
    this.passedThrough.add(url);
    trace('media', 'passthrough', { url: urlTail(url) });
  }

  private evictStaleStreams(): void {
    const now = Date.now();

    for (const [channelName, info] of this.streamInfos) {
      if (now - info.lastSeenAt > STREAM_INFO_TTL_MS) this.removeStreamInfo(channelName, info, 'ttl');
    }

    while (this.streamInfos.size > STREAM_INFO_MAX_ENTRIES) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.streamInfos) {
        if (v.lastSeenAt < oldestTime) {
          oldestKey = k;
          oldestTime = v.lastSeenAt;
        }
      }
      this.removeStreamInfo(oldestKey, this.streamInfos.get(oldestKey)!, 'cap');
    }
  }

  private removeStreamInfo(channelName: string, info: ChannelStreamInfo, reason: string): void {
    trace('stream', 'evicted', { channel: channelName, reason, inBreak: info.break !== null });
    for (const url of Object.keys(info.variants)) this.streamByUrl.delete(url);
    this.backupManager.release(channelName);
    this.streamInfos.delete(channelName);
  }
}
