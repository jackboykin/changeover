import type { GQLHeaders, ChannelStreamInfo, StreamVariant } from '../types';
import { AD_SIGNIFIER } from '../utils/constants';
import {
  parseAttributes,
  parseMasterPlaylist,
  headerInt,
  MEDIA_SEQUENCE_TAG,
  LIVE_SEQUENCE_TAG,
  mediaFormat,
  videoCodec,
} from './m3u8-parser';
import { BackupStreamManager, mintUsherUrl, SITE_FLAVOR } from './backup-stream';
import { channelFromUsherUrl, normalizeUrl, urlTail } from '../utils/url';
import { handBack, hardFlush, switchRendition } from '../player/player';
import { setBreakActive } from '../player/observer';
import { trace, digestPlaylist, captureBody, recordBreakSummary } from '../trace';

const STREAM_INFO_TTL_MS = 15 * 60_000;
const AD_REPLACEMENT_URL = 'https://twitch.tv';
const PREFETCH_TAG = '#EXT-X-TWITCH-PREFETCH:';
const PRELOAD_HINT_TAG = '#EXT-X-PRELOAD-HINT:';
const PART_TAG = '#EXT-X-PART:';

const TRACKING_URL_RE = /(X-TV-TWITCH-AD-[A-Z0-9-]+=")https?:\/\/[^"]*/g;
// Emptied rather than removed: an empty list makes the player skip verification setup.
const VERIFICATIONS_RE = /(X-TV-TWITCH-AD-ADVERIFICATIONS=")[^"]*/;

const AD_CDN_URL = /\/adsquared\/|\/_404\/|\/processing/;

function uriOf(line: string, tag: string): string {
  return parseAttributes(line.substring(tag.length))['URI'] ?? '';
}

// Live segments are tagged ,live and never come from an ad CDN; everything else is an ad.
// Low-latency hints are blanked, since the player fetches them before reading any #EXTINF.
export function markAdSegments(text: string, adSegments: Set<string>): { text: string; marked: number } {
  const hasTracking = text.includes('X-TV-TWITCH-AD-');
  const lines = text.split(/\r?\n/);
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
      if (!line.includes(',live') || AD_CDN_URL.test(segUrl)) {
        adSegments.add(segUrl);
        marked++;
      }
    } else if (line.startsWith(PREFETCH_TAG) || line.startsWith(PRELOAD_HINT_TAG)) {
      const hintUrl = line.startsWith(PREFETCH_TAG)
        ? line.substring(PREFETCH_TAG.length).trim()
        : uriOf(line, PRELOAD_HINT_TAG);
      if (hintUrl) adSegments.add(hintUrl);
      lines[i] = '';
      changed = true;
    } else if (line.startsWith(PART_TAG)) {
      const uri = uriOf(line, PART_TAG);
      if (uri && (adSegments.has(uri) || AD_CDN_URL.test(uri))) {
        adSegments.add(uri);
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
  // The ad segments of a break served without a backup, which the hooks answer with empty video.
  readonly adSegments = new Set<string>();
  private streamInfos = new Map<string, ChannelStreamInfo>();
  private streamByUrl = new Map<string, ChannelStreamInfo>();
  private backupManager: BackupStreamManager;

  constructor(
    private getHeaders: () => GQLHeaders,
    private realFetch: typeof fetch,
  ) {
    this.backupManager = new BackupStreamManager(getHeaders, realFetch);
  }

  // The full ladder the player already runs: the android floor would strand a 1440p viewer at 360p.
  async mintSitePath(channelName: string): Promise<string | null> {
    const info = this.streamInfos.get(channelName);
    if (!info) {
      trace('player', 'mint', { flavor: 'NO-STREAM-INFO', channel: channelName });
      return null;
    }
    const url = await mintUsherUrl(info, this.getHeaders(), this.realFetch, SITE_FLAVOR).catch(() => null);
    trace('player', 'mint', { flavor: url ? 'site' : 'FAILED', channel: channelName });
    return url;
  }

  async serve(url: string, text: string, isMaster: boolean): Promise<string> {
    try {
      return isMaster ? this.handleMasterPlaylist(url, text) : await this.handleMediaPlaylist(url, text);
    } catch (err) {
      trace('hls', 'process-error', { isMaster, err: String(err) });
      return text;
    }
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

    for (const variant of parseMasterPlaylist(text, masterUrl)) {
      info.variants[variant.url] = variant;
      this.streamByUrl.set(variant.url, info);
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
      trace('poll', 'passthrough', { url: urlTail(mediaUrl) });
      return text;
    }
    info.lastSeenAt = Date.now();

    return this.process(mediaUrl, text, info, info.variants[mediaUrl]!);
  }

  private async process(
    url: string,
    text: string,
    info: ChannelStreamInfo,
    variant: StreamVariant,
  ): Promise<string> {
    const rawDigest = digestPlaylist(text);
    const inAd = text.includes(AD_SIGNIFIER);

    const opened = inAd && !info.break;
    if (opened) this.openBreak(info, variant, url, text);

    if (!inAd && info.break) this.closeBreak(info, url, text);

    let served = text;
    let backupHit = false;
    let backupMs = 0;

    if (inAd) {
      const startedAt = Date.now();
      const backup = await this.backupManager.poll(info, variant);
      backupMs = Date.now() - startedAt;
      backupHit = backup !== null;
      if (backup !== null) {
        served = backup;
        const from = this.backupManager.served(info.channelName);
        const bt = info.break!;
        if (from && !bt.seam && mediaFormat(backup, from.codecs) !== mediaFormat(text, variant.codecs)) {
          bt.seam = true;
          bt.handBack = switchRendition(from);
        }
      }
    }

    let marked = 0;
    if (inAd && !backupHit) {
      const result = markAdSegments(served, this.adSegments);
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
      codec: variant.codecs,
      digest: rawDigest,
      inAd,
      backup: inAd ? { hit: backupHit, ms: backupMs } : null,
      served: backupHit ? digestPlaylist(served) : null,
      markedSegments: marked,
    });

    return served;
  }

  private openBreak(info: ChannelStreamInfo, variant: StreamVariant, url: string, raw: string): void {
    const codec = variant.codecs;
    info.break = {
      id: nextBreakId++,
      startedAt: Date.now(),
      codec,
      seam: false,
      handBack: null,
      polls: 0,
      backupHits: 0,
      backupMisses: 0,
    };
    trace('break', 'start', { breakId: info.break.id, channel: info.channelName, codec });
    captureBody('break-open', urlTail(url, 32), raw);
    setBreakActive(true);
  }

  private closeBreak(info: ChannelStreamInfo, url: string, raw: string): void {
    const { id, startedAt, handBack: rendition, ...counts } = info.break!;
    info.break = null;
    this.backupManager.endBreak(info.channelName);
    this.adSegments.clear();

    // A seam leaves the player's audio timeline out of sync on the return. Handing back the
    // rendition the player left is a switch it handles; a reload resets it when no switch was made.
    if (rendition) handBack(rendition);
    else if (counts.seam) void hardFlush();

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

  private evictStaleStreams(): void {
    const now = Date.now();
    for (const [channelName, info] of this.streamInfos) {
      if (now - info.lastSeenAt <= STREAM_INFO_TTL_MS) continue;
      trace('stream', 'evicted', { channel: channelName, inBreak: info.break !== null });
      for (const url of Object.keys(info.variants)) this.streamByUrl.delete(url);
      this.backupManager.release(channelName);
      this.streamInfos.delete(channelName);
    }
  }
}
