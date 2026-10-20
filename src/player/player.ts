import type { IVSPlayer, QualitySnapshot } from '../types';
import { videoCodec } from '../hls/m3u8-parser';
import { trace } from '../trace';
import { channelFromUsherUrl } from '../utils/url';

type FiberNode = {
  memoizedProps?: unknown;
  return?: FiberNode | null;
  child?: FiberNode | null;
  sibling?: FiberNode | null;
};

function getFiber(el: Element): FiberNode | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  return key ? (el as unknown as Record<string, FiberNode>)[key]! : null;
}

function ivsFromFiber(fiber: FiberNode): IVSPlayer | null {
  const props = fiber.memoizedProps as { mediaPlayerInstance?: Partial<IVSPlayer> } | null;
  const ivs = props?.mediaPlayerInstance;
  return typeof ivs?.load === 'function' && typeof ivs.getPath === 'function' ? (ivs as IVSPlayer) : null;
}

function findIVSPlayer(): IVSPlayer | null {
  const video = document.querySelector('video');
  if (!video) return null;

  let seed: FiberNode | null = null;
  for (let el: Element | null = video, i = 0; el && !seed && i < 40; el = el.parentElement, i++) {
    seed = getFiber(el);
  }
  if (!seed) return null;

  let root: FiberNode = seed;
  for (let i = 0; root.return && i < 100; i++) root = root.return;

  const stack: FiberNode[] = [root];
  for (let visited = 0; stack.length > 0 && visited < 20_000; visited++) {
    const node = stack.pop()!;
    const player = ivsFromFiber(node);
    if (player) return player;
    if (node.child) stack.push(node.child);
    if (node.sibling) stack.push(node.sibling);
  }
  return null;
}

// Moves the player onto its own rendition in a backup's format, so the seam becomes a rendition
// switch the player performs and handles itself. Returns what to hand back when the break ends.
export function switchRendition(target: {
  codecs: string;
  width: number;
  height: number;
}): QualitySnapshot | null {
  const ivs = findIVSPlayer();
  try {
    const codec = videoCodec(target.codecs);
    const to = ivs
      ?.getQualities?.()
      .find(
        (q) => videoCodec(q.codecs ?? '') === codec && q.width === target.width && q.height === target.height,
      );
    if (!ivs?.setQuality || !to) {
      trace('player', 'rendition-switch', {
        action: 'none',
        want: `${codec} ${target.width}x${target.height}`,
      });
      return null;
    }
    const snapshot = snapshotQuality(ivs);
    ivs.setQuality(to);
    trace('player', 'rendition-switch', { action: 'switched', from: snapshot.prev?.name, to: to.name });
    return snapshot;
  } catch (err) {
    trace('player', 'rendition-switch', { action: 'threw', err: String(err) });
    return null;
  }
}

export function handBack(snapshot: QualitySnapshot): void {
  const ivs = findIVSPlayer();
  if (ivs) restoreQuality(ivs, snapshot);
}

// A flush reloads the player's own path: a freshly minted one opens a new session, which Twitch
// greets with another pre-roll. That path can be stale, which is Twitch error #5000 and silent:
// load() empties the element without an event. So readyState is polled, and a dead flush retries
// once on a fresh mint.
let mintFreshPath: ((channelName: string) => Promise<string | null>) | null = null;

export function setFreshPathMint(mint: (channelName: string) => Promise<string | null>): void {
  mintFreshPath = mint;
}

const FLUSH_VERIFY_POLL_MS = 500;
// A warm flush is ready in ~4s, a cold one in ~7.2s.
const FLUSH_DEADLINE_MS = 12_000;
// HAVE_FUTURE_DATA.
const FLUSH_READY_RS = 3;

function snapshotQuality(ivs: IVSPlayer): QualitySnapshot {
  try {
    return { prev: ivs.getQuality?.() ?? null, wasAuto: ivs.isAutoQualityMode?.() ?? null };
  } catch {
    return { prev: null, wasAuto: null };
  }
}

// load() re-picks quality from scratch, so the viewer's choice is handed back.
function restoreQuality(ivs: IVSPlayer, { prev, wasAuto }: QualitySnapshot): void {
  if (wasAuto === true) {
    ivs.setAutoQualityMode?.(true);
    trace('player', 'quality-restore', { mode: 'auto', api: !!ivs.setAutoQualityMode });
    return;
  }
  if (!prev || !ivs.setQuality) {
    trace('player', 'quality-restore', { mode: 'skip', had: !!prev, api: !!ivs.setQuality });
    return;
  }
  try {
    ivs.setQuality(prev);
    trace('player', 'quality-restore', { mode: 'pin', to: prev.name ?? 'stored' });
  } catch (err) {
    trace('player', 'quality-restore', { mode: 'pin-threw', err: String(err) });
  }
}

function verifyFlush(ivs: IVSPlayer, attempt: number, snapshot: QualitySnapshot, tries = 1): void {
  setTimeout(() => {
    const video = document.querySelector('video');
    const rs = video?.readyState ?? -1;
    const state = {
      attempt,
      readyState: rs,
      ms: tries * FLUSH_VERIFY_POLL_MS,
      t: video ? Number(video.currentTime.toFixed(2)) : -1,
    };
    if (rs >= FLUSH_READY_RS) {
      trace('player', 'flush-verify', { action: 'ok', ...state });
      restoreQuality(ivs, snapshot);
      return;
    }
    if (tries * FLUSH_VERIFY_POLL_MS < FLUSH_DEADLINE_MS) {
      verifyFlush(ivs, attempt, snapshot, tries + 1);
      return;
    }
    trace('player', 'flush-verify', { action: 'DEAD', ...state });
    if (attempt === 0) void hardFlush(1, snapshot);
  }, FLUSH_VERIFY_POLL_MS);
}

async function mintFor(channel: string | null): Promise<string | null> {
  if (!channel) {
    trace('player', 'mint', { flavor: 'NO-CHANNEL' });
    return null;
  }
  try {
    return (await mintFreshPath?.(channel)) ?? null;
  } catch (err) {
    trace('player', 'mint-threw', { err: String(err) });
    return null;
  }
}

export async function hardFlush(attempt = 0, snapshot?: QualitySnapshot): Promise<boolean> {
  const ivs = findIVSPlayer();
  if (!ivs) {
    trace('player', 'reload', { action: 'ivs-not-found' });
    return false;
  }
  const quality = snapshot ?? snapshotQuality(ivs);

  let current = '';
  try {
    current = ivs.getPath();
  } catch {}

  // Keyed by the player's own channel: a multiview page holds masters for several.
  const channel = channelFromUsherUrl(current);
  const fresh = attempt > 0 ? await mintFor(channel) : null;

  const target = fresh ?? current;
  if (!target) {
    trace('player', 'reload', { action: 'no-path' });
    return false;
  }

  try {
    ivs.load(target);
    ivs.play();
    trace('player', 'reload', { action: fresh ? 'ivs-load-fresh' : 'ivs-load', attempt, channel });
  } catch (err) {
    trace('player', 'reload', { action: 'ivs-load-threw', err: String(err) });
    return false;
  }

  verifyFlush(ivs, attempt, quality);
  return true;
}
