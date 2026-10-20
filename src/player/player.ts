import type { IVSPlayer, IVSQuality } from '../types';
import { trace } from '../trace';
import { channelFromUsherUrl } from '../utils/url';

interface QualitySnapshot {
  prev: IVSQuality | null;
  wasAuto: boolean | null;
}

type FiberNode = {
  memoizedProps?: unknown;
  return?: FiberNode | null;
  child?: FiberNode | null;
  sibling?: FiberNode | null;
};

function getVideo(): HTMLVideoElement | null {
  return typeof document !== 'undefined' ? document.querySelector('video') : null;
}

function getFiber(el: Element): FiberNode | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  return key ? (el as unknown as Record<string, FiberNode>)[key]! : null;
}

function isIVSPlayer(obj: unknown): obj is IVSPlayer {
  const o = obj as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && typeof o.load === 'function' && typeof o.getPath === 'function';
}

function ivsFromFiber(fiber: FiberNode): IVSPlayer | null {
  const fromProps = (fiber.memoizedProps as { mediaPlayerInstance?: unknown } | null)?.mediaPlayerInstance;
  return isIVSPlayer(fromProps) ? fromProps : null;
}

export function findIVSPlayer(): IVSPlayer | null {
  const video = getVideo();
  if (!video) return null;

  let seed: FiberNode | null = null;
  for (let el: Element | null = video, i = 0; el && i < 40; el = el.parentElement, i++) {
    const fiber = getFiber(el);
    if (fiber) {
      seed = fiber;
      break;
    }
  }
  if (!seed) return null;

  let root: FiberNode = seed;
  for (let i = 0; root.return && i < 100; i++) root = root.return;

  const stack: FiberNode[] = [root];
  for (let visited = 0; stack.length && visited < 20_000; visited++) {
    const node = stack.pop()!;
    const player = ivsFromFiber(node);
    if (player) return player;
    if (node.child) stack.push(node.child);
    if (node.sibling) stack.push(node.sibling);
  }
  return null;
}

// A stale usher path is Twitch error #5000, and it is silent: load() empties the element without
// firing an event. So every flush mints a fresh path and polls readyState to confirm it took.
let mintFreshPath: ((channelName: string) => Promise<string | null>) | null = null;

export function setFreshPathMint(mint: (channelName: string) => Promise<string | null>): void {
  mintFreshPath = mint;
}

const FLUSH_VERIFY_POLL_MS = 500;
const FLUSH_DEADLINE_MS = 12_000; // a warm flush is ready in ~4s, a cold one in ~7.2s
const FLUSH_READY_RS = 3; // HAVE_FUTURE_DATA

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
    const video = getVideo();
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

export async function hardFlush(attempt = 0, snapshot?: QualitySnapshot): Promise<boolean> {
  const ivs = findIVSPlayer();
  if (!ivs) {
    trace('player', 'reload', { fullFlush: true, action: 'ivs-not-found' });
    return false;
  }

  let prevQuality: IVSQuality | null = snapshot?.prev ?? null;
  let wasAuto: boolean | null = snapshot?.wasAuto ?? null;
  if (!snapshot) {
    try {
      prevQuality = ivs.getQuality?.() ?? null;
      wasAuto = ivs.isAutoQualityMode?.() ?? null;
    } catch {}
  }

  let stalePath = '';
  try {
    stalePath = ivs.getPath();
  } catch {}

  // Keyed by the player's own channel: a multiview page holds masters for several.
  const channel = channelFromUsherUrl(stalePath);
  let fresh: string | null = null;
  if (mintFreshPath && channel) {
    try {
      fresh = await mintFreshPath(channel);
    } catch (err) {
      trace('player', 'mint-threw', { err: String(err) });
    }
  } else if (!channel) {
    trace('player', 'mint', { flavor: 'NO-CHANNEL' });
  }

  const target = fresh ?? stalePath;
  if (!target) {
    trace('player', 'reload', { fullFlush: true, action: 'no-path' });
    return false;
  }

  try {
    ivs.load(target);
    ivs.play();
    trace('player', 'reload', {
      fullFlush: true,
      action: fresh ? 'ivs-load' : 'ivs-load-stale',
      attempt,
      channel,
    });
  } catch (err) {
    trace('player', 'reload', { fullFlush: true, action: 'ivs-load-threw', err: String(err) });
    return false;
  }

  verifyFlush(ivs, attempt, { prev: prevQuality, wasAuto });
  return true;
}
