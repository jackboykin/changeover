import { trace } from '../trace';
import { hardFlush } from './player';

const SAMPLE_INTERVAL_MS = 1000;
const BREAK_TRAILING_MS = 30_000;

// The flush lands at 0.3 + 3 × 2.5 ≈ 7.8s, past a benign ~7.2s cold decoder init.
const RECOVERY_FIRST_LOOK_MS = 300;
const RECOVERY_RETRY_MS = 2500;
const RECOVERY_MAX_ACTIONS = 4;
const RECOVERY_MAX_LOOKS = 12;
const STUCK_BUFFER_S = 0.5;
// A quarter of realtime: a stream crawling forward is still broken.
const PROGRESS_MIN_S = (RECOVERY_RETRY_MS / 1000) * 0.25;
// A return freeze can raise no event at all, so the sampler arms the ladder itself.
const FREEZE_TICKS = 2;

let breakActive = false;
let stopSamplingAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let last: { v: HTMLVideoElement; t: number; still: number } | null = null;

function getVideo(): HTMLVideoElement | null {
  return typeof document !== 'undefined' ? document.querySelector('video') : null;
}

function bufferAhead(v: HTMLVideoElement): number {
  const b = v.buffered;
  return b.length > 0 ? b.end(b.length - 1) - v.currentTime : 0;
}

function rangesOf(v: HTMLVideoElement): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < v.buffered.length; i++) out.push([v.buffered.start(i), v.buffered.end(i)]);
  return out;
}

const GAP_MIN_S = 0.1;
export function gapJumpTarget(ranges: ReadonlyArray<readonly [number, number]>, t: number): number | null {
  let forward: [number, number] | null = null;
  for (const [start, end] of ranges) {
    if (start - GAP_MIN_S <= t && t <= end) {
      if (end - t >= STUCK_BUFFER_S) return null;
    } else if (start > t + GAP_MIN_S && (forward === null || start < forward[0])) {
      forward = [start, end];
    }
  }
  return forward === null ? null : Math.min(forward[0] + GAP_MIN_S, forward[1]);
}

export function isStuck(paused: boolean, ended: boolean, ahead: number): boolean {
  return paused && !ended && ahead < STUCK_BUFFER_S;
}

function videoState(v: HTMLVideoElement | null): Record<string, unknown> {
  if (!v) return { video: false };
  return {
    t: Number(v.currentTime.toFixed(2)),
    ahead: Number(bufferAhead(v).toFixed(2)),
    paused: v.paused,
    readyState: v.readyState,
    ranges: v.buffered.length,
  };
}

function tick(): void {
  if (!inSeamWindow()) {
    if (timer !== null) clearInterval(timer);
    timer = null;
    return;
  }
  sample(getVideo());
}

export function sample(v: HTMLVideoElement | null): void {
  trace('sample', 'tick', { inBreak: breakActive, ...videoState(v) });
  if (!v) return;

  const still = last?.v === v && last.t === v.currentTime && !v.ended ? last.still + 1 : 0;
  last = { v, t: v.currentTime, still };
  const userPause = v.paused && bufferAhead(v) >= STUCK_BUFFER_S;
  if (still === FREEZE_TICKS && !userPause) arm(v, 'freeze');
}

function inSeamWindow(): boolean {
  return breakActive || Date.now() < stopSamplingAt;
}

export function setBreakActive(active: boolean): void {
  breakActive = active;
  if (active) {
    stopSamplingAt = Infinity;
    timer ??= setInterval(tick, SAMPLE_INTERVAL_MS);
  } else {
    stopSamplingAt = Date.now() + BREAK_TRAILING_MS;
  }
}

export function chooseRecovery(taken: number): 'play' | 'ivs-flush' {
  return taken >= 3 ? 'ivs-flush' : 'play';
}

let ladderTarget: HTMLVideoElement | null = null;

// 'waiting' fires about once a second while stalled, so one ladder per element.
function arm(video: HTMLVideoElement, type: string): void {
  const armed = ladderTarget !== video;
  trace('stall', 'event', {
    type,
    inBreak: breakActive,
    armed,
    videos: document.querySelectorAll('video').length,
    ...videoState(video),
  });
  if (!armed) return;
  ladderTarget = video;
  recover(video, 0, 0, video.currentTime);
}

function recover(target: HTMLVideoElement, taken: number, looks: number, lastT: number): void {
  const delay = taken === 0 && looks === 0 ? RECOVERY_FIRST_LOOK_MS : RECOVERY_RETRY_MS;
  setTimeout(() => {
    try {
      step(target, taken, looks, lastT);
    } catch (err) {
      trace('recover', 'threw', { err: String(err) });
      if (ladderTarget === target) ladderTarget = null;
    }
  }, delay);
}

function step(target: HTMLVideoElement, taken: number, looks: number, lastT: number): void {
  const v = getVideo();
  if (!v || v !== target) {
    if (ladderTarget === target) ladderTarget = null;
    return;
  }
  const finish = (ev: string, extra: Record<string, unknown> = {}): void => {
    if (ev) trace('recover', ev, { taken, looks, ...extra, ...videoState(v) });
    if (ladderTarget === target) ladderTarget = null;
  };

  if (looks >= RECOVERY_MAX_LOOKS) return finish('gave-up', { reason: 'looks' });

  let level = taken;
  if (level > 0 && v.currentTime > lastT + PROGRESS_MIN_S) {
    trace('recover', 'progress', { from: level, ...videoState(v) });
    level = 0;
  }

  if (!isStuck(v.paused, v.ended, bufferAhead(v))) {
    // isStuck can't see a park before a buffer hole: unpaused, with buffer counted across the hole.
    if (!v.paused && !v.ended && level < RECOVERY_MAX_ACTIONS && inSeamWindow()) {
      const jump = gapJumpTarget(rangesOf(v), v.currentTime);
      if (jump !== null) {
        trace('recover', 'gap-jump', { taken: level, to: Number(jump.toFixed(2)), ...videoState(v) });
        v.currentTime = jump;
        recover(target, level + 1, looks + 1, jump);
        return;
      }
    }
    return finish(level > 0 || taken > 0 ? 'settled' : '');
  }

  if (level >= RECOVERY_MAX_ACTIONS) return finish('gave-up');

  const action = chooseRecovery(level);
  const at = v.currentTime;
  trace('recover', action, { taken: level, looks, action, ...videoState(v) });

  if (action === 'ivs-flush') {
    void hardFlush().then((acted) => {
      if (!acted) v.play().catch(() => {});
    });
  } else {
    v.play().catch(() => {});
  }

  recover(target, level + 1, looks + 1, at);
}

export function installObserver(): void {
  let attached: HTMLVideoElement | null = null;

  const onStall = (e: Event): void => arm(e.target as HTMLVideoElement, e.type);

  const attach = (): void => {
    const video = getVideo();
    if (video === attached) return;
    if (attached) {
      attached.removeEventListener('waiting', onStall);
      attached.removeEventListener('stalled', onStall);
      attached.removeEventListener('error', onStall);
    }
    attached = video;
    if (!video) {
      trace('player', 'video-lost', {});
      return;
    }
    video.addEventListener('waiting', onStall);
    video.addEventListener('stalled', onStall);
    video.addEventListener('error', onStall);
    trace('player', 'video-found', {});
  };

  attach();
  const observer = new MutationObserver(() => attach());
  const target = document.querySelector('.persistent-player') ?? document.body;
  if (target) observer.observe(target, { childList: true, subtree: true });
}
