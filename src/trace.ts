import { version } from '../package.json';
import { AD_SIGNIFIER } from './utils/constants';

interface TraceEntry {
  seq: number;
  t: number;
  cat: string;
  ev: string;
  data?: Record<string, unknown>;
}

// Split by volume, so ~2s polls can't evict the rare events.
const HIGH_VOLUME_CATS = new Set(['poll', 'sample']);
const RING_MAX = 700;
const STICKY_MAX = 300;
const BODIES_MAX = 12;
const BREAKS_LS_KEY = 'tab-trace-breaks';
const BREAKS_MAX = 50;
const CONSOLE_LS_KEY = 'tab-trace-console';

const startedAt = Date.now();
let seq = 0;

interface Ring {
  max: number;
  entries: TraceEntry[];
  start: number;
}

let ring: Ring = { max: RING_MAX, entries: [], start: 0 };
let sticky: Ring = { max: STICKY_MAX, entries: [], start: 0 };

function push(r: Ring, entry: TraceEntry): void {
  if (r.entries.length < r.max) {
    r.entries.push(entry);
  } else {
    r.entries[r.start] = entry;
    r.start = (r.start + 1) % r.max;
  }
}

function entriesOf(r: Ring): TraceEntry[] {
  return r.start === 0 ? [...r.entries] : [...r.entries.slice(r.start), ...r.entries.slice(0, r.start)];
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

let consoleMirror = readFlag(CONSOLE_LS_KEY);

export function trace(cat: string, ev: string, data?: Record<string, unknown>): void {
  const entry: TraceEntry = { seq: seq++, t: Date.now(), cat, ev };
  if (data !== undefined) entry.data = data;

  push(HIGH_VOLUME_CATS.has(cat) ? ring : sticky, entry);

  if (consoleMirror) {
    console.debug(`[tab ${entry.seq}] ${cat}:${ev}`, data ?? '');
  }
}

export function traceEntries(): TraceEntry[] {
  return [...entriesOf(ring), ...entriesOf(sticky)].sort((a, b) => a.seq - b.seq);
}

export function clearTrace(): void {
  ring = { max: RING_MAX, entries: [], start: 0 };
  sticky = { max: STICKY_MAX, entries: [], start: 0 };
  bodies = [];
}

interface BodyCapture {
  seq: number;
  t: number;
  kind: string;
  url: string;
  body: string;
}

let bodies: BodyCapture[] = [];

export function captureBody(kind: string, url: string, body: string): void {
  bodies.push({ seq: seq++, t: Date.now(), kind, url, body });
  if (bodies.length > BODIES_MAX) bodies.shift();
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
    const raw = localStorage.getItem(BREAKS_LS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

let breaks = readStoredBreaks();

export function recordBreakSummary(summary: Record<string, unknown>): void {
  breaks.push(summary);
  if (breaks.length > BREAKS_MAX) breaks = breaks.slice(-BREAKS_MAX);
  try {
    localStorage.setItem(BREAKS_LS_KEY, JSON.stringify(breaks));
  } catch {}
}

export type TraceDump = ReturnType<typeof dumpTrace>;

export function dumpTrace() {
  return {
    scriptVersion: version,
    ua: navigator.userAgent,
    startedAt,
    dumpedAt: Date.now(),
    breaks: [...breaks],
    events: traceEntries(),
    bodies: [...bodies],
  };
}

function downloadTrace(): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(dumpTrace())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tab-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  trace('trace', 'downloaded', {
    events: ring.entries.length + sticky.entries.length,
    breaks: breaks.length,
  });
}

function setFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {}
}

export function installTraceExport(): void {
  if (typeof window === 'undefined') return;

  (window as unknown as Record<string, unknown>)['__tabTrace'] = {
    dump: dumpTrace,
    download: downloadTrace,
    clear: clearTrace,
    setConsole: (on: boolean) => {
      consoleMirror = on;
      setFlag(CONSOLE_LS_KEY, on);
    },
  };

  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        downloadTrace();
      }
    },
    true,
  );

  trace('trace', 'installed', { version, consoleMirror });
}
