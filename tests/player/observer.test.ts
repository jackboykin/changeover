import { describe, it, expect, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';

let ivsAvailable = true;

const hardFlushMock = mock(() => Promise.resolve(ivsAvailable));

await mock.module('../../src/player/player', () => ({ hardFlush: hardFlushMock }));

const { installObserver, gapJumpTarget, setBreakActive, sample } = await import('../../src/player/observer');
const { clearTrace, traceEntries } = await import('../../src/trace');

const PARK: [number, number][] = [
  [0, 1218.2],
  [1228.0, 1242.0],
];

describe('gapJumpTarget discriminator', () => {
  it('jumps a playhead parked at a hole to just inside the forward range', () => {
    expect(gapJumpTarget(PARK, 1218.2)).toBeCloseTo(1228.1);
  });

  it('jumps when the playhead sits between ranges (inside the hole itself)', () => {
    expect(gapJumpTarget(PARK, 1220.0)).toBeCloseTo(1228.1);
  });

  it('never skips content a decoder stall could still play (contiguous data ahead)', () => {
    expect(gapJumpTarget([[0, 1225.0], PARK[1]!], 1218.2)).toBeNull();
  });

  it('does nothing for plain starvation (no data ahead at all)', () => {
    expect(gapJumpTarget([PARK[0]!], 1218.2)).toBeNull();
    expect(gapJumpTarget([], 42)).toBeNull();
  });

  it('ignores sub-frame jitter holes', () => {
    expect(
      gapJumpTarget(
        [
          [0, 100.0],
          [100.05, 110.0],
        ],
        100.0,
      ),
    ).toBeNull();
  });

  it('never lands past the end of a tiny forward range', () => {
    const target = gapJumpTarget(
      [
        [0, 10],
        [20.0, 20.05],
      ],
      10,
    );
    expect(target).not.toBeNull();
    expect(target!).toBeLessThanOrEqual(20.05);
  });
});

interface FakeVideo {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  readyState: number;
  buffered: { length: number; start: (i: number) => number; end: (i: number) => number };
  play: ReturnType<typeof mock>;
  addEventListener: (type: string, fn: (e: Event) => void) => void;
  removeEventListener: (type: string, fn: (e: Event) => void) => void;
  _listeners: Record<string, ((e: Event) => void)[]>;
  dispatch: (type: string) => void;
}

function makeVideo(over: Partial<FakeVideo> = {}): FakeVideo {
  const listeners: Record<string, ((e: Event) => void)[]> = {};
  const v: FakeVideo = {
    paused: true,
    ended: false,
    currentTime: 88.7,
    readyState: 2,
    buffered: { length: 1, start: () => 0, end: () => 88.72 },
    play: mock(() => Promise.resolve()),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
    _listeners: listeners,
    dispatch(type) {
      for (const fn of listeners[type] ?? []) fn({ type, target: v } as unknown as Event);
    },
    ...over,
  };
  return v;
}

describe('stall recovery integration', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realDocument = globalThis.document;
  let video: FakeVideo;

  function installFakeDom(v: FakeVideo): void {
    (globalThis as unknown as { document: unknown }).document = {
      querySelector: (sel: string) => (sel === 'video' ? v : {}),
      querySelectorAll: (sel: string) => (sel === 'video' ? [v] : []),
      body: {},
    };
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void) => {
      fn();
      return 0;
    };
    (globalThis as unknown as { setInterval: unknown }).setInterval = () => 0;
    (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = class {
      observe() {}
      disconnect() {}
    };
  }

  beforeEach(() => {
    clearTrace();
    ivsAvailable = true;
    hardFlushMock.mockClear();
  });

  afterEach(() => {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (globalThis as unknown as { setInterval: unknown }).setInterval = realSetInterval;
    (globalThis as unknown as { document: unknown }).document = realDocument;
    setSystemTime();
  });

  function recoverActions(): string[] {
    return traceEntries()
      .filter((e) => e.cat === 'recover')
      .map((e) => e.ev);
  }

  it('escalates play ×3 → ivs-flush, then gives up, on a video that stays stuck', () => {
    video = makeVideo();
    installFakeDom(video);
    installObserver();

    video.dispatch('waiting');

    expect(recoverActions()).toEqual(['play', 'play', 'play', 'ivs-flush', 'gave-up']);
    expect(hardFlushMock).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(88.7);
  });

  it('does not kick a user pause of a well-buffered stream', () => {
    video = makeVideo({ buffered: { length: 1, start: () => 0, end: () => 96.7 } });
    installFakeDom(video);
    installObserver();

    video.dispatch('waiting');

    expect(recoverActions()).toEqual([]);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('stops the moment the element resumes playing', () => {
    video = makeVideo();
    video.play = mock(() => {
      video.paused = false;
      return Promise.resolve();
    });
    installFakeDom(video);
    installObserver();

    video.dispatch('waiting');

    expect(recoverActions()).toEqual(['play', 'settled']);
    expect(hardFlushMock).not.toHaveBeenCalled();
  });

  it('never touches a player that is only buffering (not paused)', () => {
    video = makeVideo({ paused: false });
    installFakeDom(video);
    installObserver();

    video.dispatch('waiting');

    expect(recoverActions()).toEqual([]);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('falls back to play() when the flush cannot drive IVS', async () => {
    ivsAvailable = false;
    video = makeVideo();
    installFakeDom(video);
    installObserver();

    video.dispatch('waiting');
    await Promise.resolve();
    await Promise.resolve();

    expect(recoverActions()).toEqual(['play', 'play', 'play', 'ivs-flush', 'gave-up']);
    expect(video.play).toHaveBeenCalledTimes(4);
  });

  function parkedVideo(): FakeVideo {
    return makeVideo({
      paused: false,
      currentTime: 1218.2,
      buffered: { length: 2, start: (i) => PARK[i]![0], end: (i) => PARK[i]![1] },
    });
  }

  it('leaves a mid-viewing gap alone outside the seam window', () => {
    // Close any break an earlier test opened, then step past its trailing window.
    setBreakActive(false);
    setSystemTime(new Date(Date.now() + 60_000));
    video = parkedVideo();
    installFakeDom(video);
    installObserver();

    video.dispatch('waiting');

    expect(video.currentTime).toBe(1218.2);
    expect(recoverActions()).toEqual([]);
  });

  it('gap-jumps a playhead parked before a hole during a seam window', () => {
    video = parkedVideo();
    installFakeDom(video);
    installObserver();
    setBreakActive(true);

    video.dispatch('waiting');
    setBreakActive(false);

    expect(video.currentTime).toBeCloseTo(1228.1);
    expect(recoverActions()).toEqual(['gap-jump', 'settled']);
    expect(video.play).not.toHaveBeenCalled();
    expect(hardFlushMock).not.toHaveBeenCalled();
  });

  it('arms one ladder no matter how many stall signals arrive during it', () => {
    video = makeVideo();
    installFakeDom(video);
    installObserver();
    video.play = mock(() => {
      video.dispatch('waiting');
      return Promise.resolve();
    });

    video.dispatch('waiting');

    expect(recoverActions()).toEqual(['play', 'play', 'play', 'ivs-flush', 'gave-up']);
    expect(video.play).toHaveBeenCalledTimes(3);
    const stalls = traceEntries().filter((e) => e.cat === 'stall');
    expect(stalls.length).toBeGreaterThan(1);
    expect(stalls.filter((e) => e.data?.['armed'] === true)).toHaveLength(1);
  });

  it('resets escalation when the playhead advances, so it never reaches the flush', () => {
    video = makeVideo();
    installFakeDom(video);
    installObserver();
    video.play = mock(() => {
      video.currentTime += 1.5;
      return Promise.resolve();
    });

    video.dispatch('waiting');

    expect(recoverActions()).not.toContain('ivs-flush');
    expect(hardFlushMock).not.toHaveBeenCalled();
    expect(recoverActions().filter((e) => e === 'progress').length).toBeGreaterThan(0);
    expect(recoverActions().at(-1)).toBe('gave-up');
    expect(traceEntries().find((e) => e.ev === 'gave-up')?.data?.['reason']).toBe('looks');
  });

  it('still flushes a stream that only crawls — barely moving is not recovering', () => {
    video = makeVideo();
    installFakeDom(video);
    installObserver();
    video.play = mock(() => {
      video.currentTime += 0.05;
      return Promise.resolve();
    });

    video.dispatch('waiting');

    expect(recoverActions()).toEqual(['play', 'play', 'play', 'ivs-flush', 'gave-up']);
    expect(recoverActions()).not.toContain('progress');
    expect(hardFlushMock).toHaveBeenCalledTimes(1);
  });

  it('releases the ladder when a step throws, so a later stall can still arm', () => {
    video = parkedVideo();
    installFakeDom(video);
    installObserver();
    setBreakActive(true);
    Object.defineProperty(video, 'currentTime', {
      get: () => 1218.2,
      set: () => {
        throw new Error('InvalidStateError');
      },
    });

    video.dispatch('waiting');
    video.dispatch('waiting');
    setBreakActive(false);

    expect(traceEntries().find((e) => e.ev === 'threw')).toBeDefined();
    const armed = traceEntries().filter((e) => e.cat === 'stall' && e.data?.['armed'] === true);
    expect(armed).toHaveLength(2);
  });

  function freezeEvents() {
    return traceEntries().filter((e) => e.cat === 'stall' && e.data?.['type'] === 'freeze');
  }

  it('arms the ladder when the sampler sees a starved playhead hold still', () => {
    video = makeVideo();
    installFakeDom(video);
    installObserver();
    setBreakActive(true);

    sample(video as unknown as HTMLVideoElement);
    sample(video as unknown as HTMLVideoElement);
    expect(freezeEvents()).toHaveLength(0);
    sample(video as unknown as HTMLVideoElement);

    expect(freezeEvents()).toHaveLength(1);
    expect(recoverActions()[0]).toBe('play');
  });

  it('leaves a user pause alone however long it holds', () => {
    video = makeVideo({ buffered: { length: 1, start: () => 0, end: () => 96.7 } });
    installFakeDom(video);
    installObserver();
    setBreakActive(true);

    for (let i = 0; i < 5; i++) sample(video as unknown as HTMLVideoElement);

    expect(freezeEvents()).toHaveLength(0);
    expect(recoverActions()).toEqual([]);
  });
});
