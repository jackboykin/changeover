import type { ChannelStreamInfo, GQLHeaders, StreamVariant } from '../types';
import { AD_SIGNIFIER, PLAYBACK_ACCESS_TOKEN_HASH, GQL_URL, USHER_BASE_URL } from '../utils/constants';
import { parseMasterPlaylist, videoCodec } from './m3u8-parser';
import { trace } from '../trace';

interface Session {
  ladder: StreamVariant[];
  mediaUrl: string;
  codecs: string;
  acquiredAt: number;
  resolution: string;
  text: string;
  fetchedAt: number;
  lastPollAt: number;
  timer: ReturnType<typeof setInterval> | null;
}

interface Pending {
  pending: true;
}

interface Acquired {
  ladder: StreamVariant[];
  mediaUrl: string;
  codecs: string;
  text: string;
  flavor: string;
}

interface Backoff {
  failCount: number;
  until: number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

const REFRESH_MS = 1000; // half the player's ~2s reload
const STALE_MS = 2500;
const POLL_IDLE_MS = 6000;

interface TokenFlavor {
  playerType: string;
  platform: string;
}

export const BACKUP_FLAVOR: TokenFlavor = { playerType: 'autoplay', platform: 'android' };
export const SITE_FLAVOR: TokenFlavor = { playerType: 'site', platform: 'web' };

// In priority order. The web flavors carry the full ladder, HEVC included; android is a
// two-variant floor that has never come back stitched.
const BACKUP_FLAVORS: readonly TokenFlavor[] = [
  { playerType: 'embed', platform: 'web' },
  { playerType: 'popout', platform: 'web' },
  BACKUP_FLAVOR,
];

export type UsherTarget = Pick<ChannelStreamInfo, 'channelName' | 'usherParams' | 'isUsherV2'>;

export async function mintUsherUrl(
  { channelName, usherParams, isUsherV2 }: UsherTarget,
  headers: GQLHeaders,
  realFetch: typeof fetch,
  flavor: TokenFlavor,
): Promise<string | null> {
  const token = await fetchAccessToken(channelName, headers, realFetch, flavor);
  if (!token) return null;

  const url = new URL(
    `${USHER_BASE_URL}${isUsherV2 ? 'v2/' : ''}channel/hls/${channelName}.m3u8${usherParams}`,
  );
  url.searchParams.set('sig', token.sig);
  url.searchParams.set('token', token.token);
  return url.href;
}

async function fetchAccessToken(
  channelName: string,
  h: GQLHeaders,
  realFetch: typeof fetch,
  flavor: TokenFlavor,
): Promise<{ sig: string; token: string } | null> {
  const headers: Record<string, string> = {
    'Client-ID': h.clientId,
    'Content-Type': 'application/json',
  };
  if (h.deviceId) headers['X-Device-Id'] = h.deviceId;
  if (h.authorization) headers['Authorization'] = h.authorization;
  if (h.integrity) headers['Client-Integrity'] = h.integrity;
  if (h.version) headers['Client-Version'] = h.version;
  if (h.session) headers['Client-Session-Id'] = h.session;

  const resp = await realFetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationName: 'PlaybackAccessToken',
      variables: {
        isLive: true,
        login: channelName,
        isVod: false,
        vodID: '',
        playerType: flavor.playerType,
        platform: flavor.platform,
      },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: h.accessTokenHash ?? PLAYBACK_ACCESS_TOKEN_HASH },
      },
    }),
  });
  if (resp.status !== 200) return null;

  const json = (await resp.json()) as {
    data?: { streamPlaybackAccessToken?: { signature: string; value: string } };
  };
  const token = json.data?.streamPlaybackAccessToken;
  return token ? { sig: token.signature, token: token.value } : null;
}

// One session per channel, held across breaks. Each refreshes itself, so a poll serves a copy
// already fetched instead of waiting on the network inside the player's reload.
export class BackupStreamManager {
  private sessions = new Map<string, Session | Pending>();
  private backoffs = new Map<string, Backoff>();

  constructor(
    private getHeaders: () => GQLHeaders,
    private realFetch: typeof fetch,
  ) {}

  // An installed session is kept for the next break; an in-flight one is dropped, as its token
  // will have aged by then.
  endBreak(channelName: string): void {
    const session = this.sessions.get(channelName);
    if (session && 'pending' in session) this.sessions.delete(channelName);
  }

  release(channelName: string): void {
    this.stopRefresh(this.sessions.get(channelName));
    this.sessions.delete(channelName);
    this.backoffs.delete(channelName);
  }

  servedCodecs(channelName: string): string | null {
    const session = this.sessions.get(channelName);
    return session && !('pending' in session) ? session.codecs : null;
  }

  async poll(target: UsherTarget, variant: StreamVariant): Promise<string | null> {
    const { channelName } = target;
    const existing = this.sessions.get(channelName);
    if (existing && 'pending' in existing) return null;
    if (existing) {
      if (existing.resolution !== variant.resolution) this.switchVariant(channelName, existing, variant);
      const now = Date.now();
      const resuming = now - existing.lastPollAt > POLL_IDLE_MS;
      existing.lastPollAt = now;
      this.startRefresh(channelName, existing);
      if (now - existing.fetchedAt < STALE_MS) return existing.text;

      // A failed refresh mid-break waits a poll; after a polling gap the URL has likely aged, so
      // acquire now.
      const text = await this.fetchMedia(channelName, existing);
      if (text !== null || !resuming) return text;
    }

    const backoff = this.backoffs.get(channelName);
    if (backoff && Date.now() < backoff.until) {
      trace('backup', 'backoff-skip', { channel: channelName });
      return null;
    }

    const pending: Pending = { pending: true };
    this.sessions.set(channelName, pending);
    const startedAt = Date.now();
    let acquired: Acquired | null = null;
    try {
      acquired = await this.acquireSession(target, variant);
    } catch (err) {
      trace('backup', 'acquire-error', { channel: channelName, err: String(err) });
    }

    if (this.sessions.get(channelName) !== pending) {
      trace('backup', 'acquire-discarded', { channel: channelName });
      return null;
    }

    if (!acquired) {
      this.sessions.delete(channelName);
      this.recordFailure(channelName);
      trace('backup', 'acquire-failed', { channel: channelName, ms: Date.now() - startedAt });
      return null;
    }

    this.backoffs.delete(channelName);
    const now = Date.now();
    const session: Session = {
      ladder: acquired.ladder,
      mediaUrl: acquired.mediaUrl,
      codecs: acquired.codecs,
      acquiredAt: now,
      resolution: variant.resolution,
      text: acquired.text,
      fetchedAt: now,
      lastPollAt: now,
      timer: null,
    };
    this.sessions.set(channelName, session);
    this.startRefresh(channelName, session);
    trace('backup', 'acquired', {
      channel: channelName,
      ms: Date.now() - startedAt,
      flavor: acquired.flavor,
    });
    return acquired.text;
  }

  private switchVariant(channelName: string, session: Session, variant: StreamVariant): void {
    trace('backup', 'variant-changed', {
      channel: channelName,
      from: session.resolution,
      to: variant.resolution,
    });
    const chosen = pickVariant(session.ladder, variant)!;
    traceMatch(variant, chosen, session.ladder);
    session.resolution = variant.resolution;
    if (chosen.url === session.mediaUrl) return;
    session.mediaUrl = chosen.url;
    session.codecs = chosen.codecs;
    session.fetchedAt = 0;
  }

  private startRefresh(channelName: string, session: Session): void {
    if (session.timer !== null) return;
    const timer = setInterval(() => {
      if (this.sessions.get(channelName) !== session || Date.now() - session.lastPollAt > POLL_IDLE_MS)
        return this.stopRefresh(session);
      void this.fetchMedia(channelName, session);
    }, REFRESH_MS);
    (timer as { unref?: () => void }).unref?.(); // so it never holds a test open
    session.timer = timer;
  }

  private stopRefresh(session: Session | Pending | undefined): void {
    if (!session || 'pending' in session || session.timer === null) return;
    clearInterval(session.timer);
    session.timer = null;
  }

  private async fetchMedia(channelName: string, session: Session): Promise<string | null> {
    let reason = 'fetch-error';
    const at = Date.now();
    try {
      const resp = await this.realFetch(session.mediaUrl);
      if (resp.status === 200) {
        const text = await resp.text();
        if (!text.includes(AD_SIGNIFIER)) {
          // A later fetch wins over a slower response.
          if (at > session.fetchedAt) {
            session.text = text;
            session.fetchedAt = at;
          }
          return session.text;
        }
        reason = 'stitched';
      } else {
        reason = `status-${resp.status}`;
      }
    } catch {}
    this.stopRefresh(session);
    if (this.sessions.get(channelName) === session) this.sessions.delete(channelName);
    trace('backup', 'session-dropped', {
      channel: channelName,
      reason,
      ageMs: Date.now() - session.acquiredAt,
    });
    return null;
  }

  private async acquireSession(target: UsherTarget, variant: StreamVariant): Promise<Acquired | null> {
    // Every chain starts at once and is judged in priority order, so the wait is the slowest chain
    // ahead of the winner rather than their sum. A losing chain is never awaited: tryFlavor must
    // not reject.
    const chains = BACKUP_FLAVORS.map((flavor) => this.tryFlavor(target, variant, flavor));
    for (const chain of chains) {
      const got = await chain;
      if (!got) continue;
      if (got.stitched) {
        trace('backup', 'flavor-stitched', { channel: target.channelName, flavor: got.flavor });
        continue;
      }
      traceMatch(variant, got.chosen, got.ladder);
      return got;
    }
    return null;
  }

  private async tryFlavor(
    target: UsherTarget,
    variant: StreamVariant,
    flavor: TokenFlavor,
  ): Promise<(Acquired & { chosen: StreamVariant; stitched: boolean }) | null> {
    try {
      const masterUrl = await mintUsherUrl(target, this.getHeaders(), this.realFetch, flavor);
      if (!masterUrl) return null;

      const masterResp = await this.realFetch(masterUrl);
      if (masterResp.status !== 200) return null;

      const ladder = parseLadder(await masterResp.text(), masterUrl);
      const chosen = pickVariant(ladder, variant);
      if (!chosen) return null;

      const mediaResp = await this.realFetch(chosen.url);
      if (mediaResp.status !== 200) return null;
      const text = await mediaResp.text();

      const stitched = text.includes(AD_SIGNIFIER);
      return {
        ladder,
        chosen,
        mediaUrl: chosen.url,
        codecs: chosen.codecs,
        text,
        flavor: flavor.playerType,
        stitched,
      };
    } catch (err) {
      trace('backup', 'flavor-error', {
        channel: target.channelName,
        flavor: flavor.playerType,
        err: String(err),
      });
      return null;
    }
  }

  private recordFailure(channelName: string): void {
    const backoff = this.backoffs.get(channelName) ?? { failCount: 0, until: 0 };
    backoff.failCount++;
    const cap = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(backoff.failCount, 15), BACKOFF_MAX_MS);
    backoff.until = Date.now() + Math.random() * cap;
    this.backoffs.set(channelName, backoff);
    trace('backup', 'backoff', {
      channel: channelName,
      failCount: backoff.failCount,
      untilMs: backoff.until - Date.now(),
    });
  }
}

function parseLadder(masterM3u8: string, masterUrl: string): StreamVariant[] {
  const ladder = parseMasterPlaylist(masterM3u8);
  for (const v of ladder) v.url = new URL(v.url, masterUrl).href;
  return ladder;
}

// The rendition nearest the target: size first, then frame rate, then video codec, so a ladder
// carrying both codecs at one size never hands over a seam it could avoid.
function pickVariant(ladder: readonly StreamVariant[], target: StreamVariant): StreamVariant | null {
  const area = target.width * target.height;
  const codec = videoCodec(target.codecs);
  const cost = (v: StreamVariant): number =>
    Math.abs(v.width * v.height - area) * 4 +
    (v.frameRate === target.frameRate ? 0 : 2) +
    (videoCodec(v.codecs) === codec ? 0 : 1);
  let best: StreamVariant | null = null;
  for (const v of ladder) if (!best || cost(v) < cost(best)) best = v;
  return best;
}

function traceMatch(target: StreamVariant, chosen: StreamVariant, ladder: readonly StreamVariant[]): void {
  trace('backup', 'variant-match', {
    target: target.resolution,
    targetCodec: videoCodec(target.codecs),
    chosenCodec: videoCodec(chosen.codecs),
    chosen: chosen.resolution,
    exact: chosen.resolution === target.resolution,
    offered: ladder.map((v) => v.resolution).join(','),
  });
}
