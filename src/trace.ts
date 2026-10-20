import { version } from '../package.json';
import { AD_SIGNIFIER } from './utils/constants';

interface TraceEntry {
  seq: number;
  t: number;
  cat: string;
  ev: string;
  data?: Record<string, unknown> | undefined;
}

interface BodyCapture {
  seq: number;
  t: number;
  kind: string;
  url: string;
  body: string;
}

// Split by volume, so ~2s polls can't evict the rare events.
const HIGH_VOLUME_CATS = new Set(['poll', 'sample']);
const FREQUENT_MAX = 700;
const RARE_MAX = 300;
const BODIES_MAX = 12;
const BREAKS_LS_KEY = 'tab-trace-breaks';
const BREAKS_MAX = 50;

const startedAt = Date.now();
let seq = 0;
const frequent: TraceEntry[] = [];
const rare: TraceEntry[] = [];
const bodies: BodyCapture[] = [];
const breaks = readStoredBreaks();

function pushCapped<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.shift();
}

export function trace(cat: string, ev: string, data?: Record<string, unknown>): void {
  const entry = { seq: seq++, t: Date.now(), cat, ev, data };
  if (HIGH_VOLUME_CATS.has(cat)) pushCapped(frequent, entry, FREQUENT_MAX);
  else pushCapped(rare, entry, RARE_MAX);
}

export function traceEntries(): TraceEntry[] {
  return [...frequent, ...rare].sort((a, b) => a.seq - b.seq);
}

export function clearTrace(): void {
  frequent.length = 0;
  rare.length = 0;
  bodies.length = 0;
}

export function captureBody(kind: string, url: string, body: string): void {
  pushCapped(bodies, { seq: seq++, t: Date.now(), kind, url, body }, BODIES_MAX);
}

export function digestPlaylist(text: string) {
  const digest = {
    bytes: text.length,
    segments: 0,
    live: 0,
    stitched: text.includes(AD_SIGNIFIER),
    maf: text.includes('twitch-maf-ad'),
    prefetch: 0,
    preloadHints: 0,
    parts: 0,
    discontinuities: 0,
    mediaSeq: null as number | null,
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('#EXTINF')) {
      digest.segments++;
      if (line.includes(',live')) digest.live++;
    } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
      digest.prefetch++;
    } else if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
      digest.preloadHints++;
    } else if (line.startsWith('#EXT-X-PART:')) {
      digest.parts++;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      digest.discontinuities++;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const n = parseInt(line.substring('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
      if (!Number.isNaN(n)) digest.mediaSeq = n;
    }
  }

  return digest;
}

function readStoredBreaks(): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(BREAKS_LS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

export function recordBreakSummary(summary: Record<string, unknown>): void {
  pushCapped(breaks, summary, BREAKS_MAX);
  try {
    localStorage.setItem(BREAKS_LS_KEY, JSON.stringify(breaks));
  } catch {}
}

export type TraceDump = ReturnType<typeof dumpTrace>;

function dumpTrace() {
  return {
    scriptVersion: version,
    ua: navigator.userAgent,
    startedAt,
    dumpedAt: Date.now(),
    breaks,
    events: traceEntries(),
    bodies,
  };
}

function downloadTrace(): void {
  const blob = new Blob([JSON.stringify(dumpTrace())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tab-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function installTraceExport(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'L') {
        e.preventDefault();
        downloadTrace();
      }
    },
    true,
  );
}
