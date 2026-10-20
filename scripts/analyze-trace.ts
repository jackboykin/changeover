import { readFileSync } from 'fs';
import type { TraceDump } from '../src/trace';

type Entry = TraceDump['events'][number];

const path = process.argv[2];
if (!path) {
  console.error('usage: bun run scripts/analyze-trace.ts <changeover-trace-*.json>');
  process.exit(1);
}
const dump = JSON.parse(readFileSync(path, 'utf-8')) as TraceDump;
const events = dump.events ?? [];
const bodies = dump.bodies ?? [];

const hms = (t: number) => new Date(t).toTimeString().slice(0, 8);
const rel = (t: number, t0: number) => `+${((t - t0) / 1000).toFixed(1)}s`;
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((100 * a) / b)}%`);
const count = (cat: string, ev: string) => events.filter((e) => e.cat === cat && e.ev === ev).length;

function median(xs: number[]): string {
  if (xs.length === 0) return '—';
  const s = [...xs].sort((a, b) => a - b);
  return `${s[Math.floor(s.length / 2)]!}ms`;
}

console.log(`trace ${path}`);
console.log(
  `  script v${dump.scriptVersion}  events ${events.length}  span ${hms(dump.startedAt)}–${hms(dump.dumpedAt)}`,
);
const breaks = dump.breaks ?? [];
const sessionBreaks = breaks.filter((b) => Number(b['endedAt']) >= dump.startedAt).length;
console.log(`  breaks stored: ${breaks.length}  this session: ${sessionBreaks}\n`);

for (const start of events.filter((e) => e.cat === 'break' && e.ev === 'start')) {
  const id = start.data?.['breakId'];
  const t0 = start.t;
  const end = events.find((e) => e.cat === 'break' && e.ev === 'end' && e.data?.['breakId'] === id);
  const tEnd = end?.t ?? dump.dumpedAt;

  console.log(
    `━━ break #${String(id)}  ${String(start.data?.['channel'])}  codec=${String(start.data?.['codec'])}  ${hms(t0)}`,
  );

  const window = events.filter((e) => e.t >= t0 && e.t <= tEnd + 30_000);
  for (const e of window) {
    const d = e.data ?? {};
    let line: string | null = null;

    if (e.cat === 'poll' && e.ev === 'decision') {
      const backup = d['backup'] as { hit?: boolean; ms?: number } | null;
      const marked = num(d['markedSegments']) ?? 0;
      const bits = [
        d['inAd'] ? 'AD  ' : 'live',
        backup ? (backup.hit ? `backup✓(${backup.ms}ms)` : `backup✗(${backup.ms}ms)`) : '',
        marked > 0 ? `marked=${marked}` : '',
      ].filter(Boolean);
      line = `poll     ${bits.join('  ')}`;
    } else if (e.cat === 'break' && e.ev === 'end') {
      line = `break    end  polls=${d['polls']} hits=${d['backupHits']} misses=${d['backupMisses']} seam=${d['seam']}`;
    } else if (e.cat === 'backup' && e.ev === 'variant-match') {
      const tag = d['exact'] ? 'exact' : 'DOWNGRADE';
      line = `backup   variant-match  ${tag}  want ${d['target']} ${d['targetCodec']} → ${d['chosen']} ${d['chosenCodec']}  [${d['offered']}]`;
    } else if (e.cat === 'backup') {
      line = `backup   ${e.ev}  ${String(d['reason'] ?? d['flavor'] ?? '')}`.trimEnd();
    } else if (e.cat === 'player' && e.ev === 'quality-restore') {
      line = `player   quality-restore  ${String(d['mode'])}  ${String(d['to'] ?? '')}`.trimEnd();
    } else if (e.cat === 'player' && e.ev === 'mint') {
      line = `player   mint  ${String(d['flavor'])}`;
    } else if (e.cat === 'player') {
      line = `player   ${e.ev}  ${String(d['action'] ?? '')}`.trimEnd();
    } else if (e.cat === 'stall') {
      line = `STALL    ${e.ev}  ${JSON.stringify(d)}`;
    } else if (e.cat === 'recover') {
      line = `RECOVER  ${e.ev}  ${JSON.stringify(d)}`;
    } else if (e.cat === 'master' && e.ev === 'handled') {
      line = `master   handled  variants=${d['variants']} codecs=${d['codecs']}`;
    } else if (e.ev === 'hls-status') {
      line = `HLS !${e.data?.['status']}  ${e.data?.['isMaster'] ? 'master' : 'media'}  ${e.data?.['url']}`;
    }
    if (line) console.log(`  ${rel(e.t, t0).padStart(7)}  ${line}`);
  }

  const ticks = window.filter((e) => e.cat === 'sample');
  if (ticks.length > 0) {
    const paused = ticks.filter((e) => e.data?.['paused'] === true).length;
    const blind = ticks.filter((e) => e.data?.['video'] === false).length;
    const positions = ticks.map((e) => num(e.data?.['t'])).filter((v): v is number => v !== null);
    const advanced =
      positions.length > 1 ? (positions[positions.length - 1]! - positions[0]!).toFixed(1) : '—';
    console.log(
      `  sampler: ${ticks.length} ticks, ${paused} paused, ${blind} no-video, playhead advanced ${advanced}s`,
    );
  }
  const winBodies = bodies.filter((b) => b.t >= t0 && b.t <= tEnd + 30_000);
  if (winBodies.length > 0) {
    console.log(`  bodies captured: ${winBodies.map((b) => b.kind).join(', ')} (in dump.bodies)`);
  }
  console.log('');
}

console.log('━━ aggregates\n');

const decisions = events.filter((e) => e.cat === 'poll' && e.ev === 'decision');
const adPolls = decisions.filter((e) => e.data?.['inAd'] === true);
const hits = adPolls.filter((e) => (e.data?.['backup'] as { hit?: boolean } | null)?.hit === true);
const latencies = adPolls
  .map((e) => num((e.data?.['backup'] as { ms?: number } | null)?.ms))
  .filter((v): v is number => v !== null);

console.log(`polls: ${decisions.length} (${adPolls.length} during ad breaks)`);
console.log(`  backup hit rate   ${hits.length}/${adPolls.length} (${pct(hits.length, adPolls.length)})`);
console.log(`  backup latency    median ${median(latencies)}`);
console.log(
  `  ad segments marked (backup-miss fallback)  ${adPolls.reduce((n, e) => n + (num(e.data?.['markedSegments']) ?? 0), 0)}`,
);

const STUCK_BUFFER_S = 0.5;
const BLIP_S = 1.0;
const stalls = events.filter((e) => e.cat === 'stall' && e.ev === 'event');
const isStuckSnap = (d: Record<string, unknown> | undefined): boolean =>
  !!d && d['paused'] === true && (num(d['ahead']) ?? 99) < STUCK_BUFFER_S;
const isPlayingSnap = (d: Record<string, unknown> | undefined): boolean =>
  !!d && d['paused'] === false && (num(d['ahead']) ?? 0) > STUCK_BUFFER_S;

function recoveryDelay(stall: Entry): number | null {
  for (const e of events) {
    if (e.seq <= stall.seq) continue;
    const playing = (e.cat === 'stall' || e.cat === 'sample') && isPlayingSnap(e.data);
    const settled = e.cat === 'recover' && e.ev === 'settled';
    if (playing || settled) return (e.t - stall.t) / 1000;
  }
  return null;
}

interface Classified {
  ev: Entry;
  real: boolean;
  recoveredIn: number | null;
  dumpEndedAfter: number;
}
const classified: Classified[] = stalls.map((stall) => ({
  ev: stall,
  real: isStuckSnap(stall.data),
  recoveredIn: recoveryDelay(stall),
  dumpEndedAfter: (dump.dumpedAt - stall.t) / 1000,
}));
const real = classified.filter((c) => c.real);
const benign = classified.length - real.length;

console.log(`\nstall events (waiting/stalled/error on <video>): ${stalls.length}`);
console.log(`  benign buffering (not stuck)  ${benign}`);
console.log(`  REAL stalls (paused + empty)  ${real.length}`);
for (const c of real) {
  const d = c.ev.data ?? {};
  let verdict: string;
  if (c.recoveredIn !== null) {
    const label = c.recoveredIn < BLIP_S ? 'blip, clean' : 'recovered';
    verdict = `${label} in ${c.recoveredIn.toFixed(2)}s`;
  } else if (c.dumpEndedAfter < 2) {
    verdict = `unknown (dump ended ${c.dumpEndedAfter.toFixed(1)}s later)`;
  } else {
    verdict = `STILL STUCK (no recovery seen in ${c.dumpEndedAfter.toFixed(1)}s)`;
  }
  console.log(
    `    ${verdict}  inBreak=${d['inBreak']}  fire{paused=${d['paused']} ahead=${d['ahead']} rs=${d['readyState']}}`,
  );
}
if (real.length > 0) {
  const clean = real.filter((c) => c.recoveredIn !== null && c.recoveredIn < BLIP_S).length;
  const slow = real.filter((c) => c.recoveredIn !== null && c.recoveredIn >= BLIP_S).length;
  const stuck = real.filter((c) => c.recoveredIn === null && c.dumpEndedAfter >= 2).length;
  console.log(`  → ${clean} imperceptible blip(s), ${slow} slow recovery(ies), ${stuck} left stuck`);
}

const recoverEvents = events.filter((e) => e.cat === 'recover');
if (recoverEvents.length > 0) {
  const nonAction = ['settled', 'gave-up'];
  console.log(`\nrecovery actions fired: ${recoverEvents.filter((e) => !nonAction.includes(e.ev)).length}`);
  for (const ev of ['play', 'gap-jump', 'ivs-flush', 'settled', 'gave-up']) {
    const n = recoverEvents.filter((e) => e.ev === ev).length;
    if (n > 0) console.log(`  ${ev.padEnd(16)} ${n}`);
  }
  const settled = recoverEvents.filter((e) => e.ev === 'settled');
  if (settled.length > 0) {
    const worked = settled.map((e) => num(e.data?.['taken']) ?? 0);
    console.log(`  → recovered after N actions: ${worked.join(', ')} (1-3=play/gap-jump, 4=after ivs-flush)`);
  }
}

console.log(`\nbackup sessions:`);
console.log(`  acquired          ${count('backup', 'acquired')}`);
console.log(`  acquire failed    ${count('backup', 'acquire-failed')}`);
console.log(`  dropped mid-break ${count('backup', 'session-dropped')}`);
console.log(`  backoff-skipped   ${count('backup', 'backoff-skip')}`);
console.log(`  rendition changed ${count('backup', 'variant-changed')}`);

const acquires = events.filter((e) => e.cat === 'backup' && e.ev === 'acquired');
if (acquires.length > 0) {
  const byFlavor = new Map<string, number>();
  for (const a of acquires) {
    const f = String(a.data?.['flavor'] ?? '?');
    byFlavor.set(f, (byFlavor.get(f) ?? 0) + 1);
  }
  console.log(`  won by flavor     ${[...byFlavor].map(([f, n]) => `${f}×${n}`).join('  ')}`);
}
const stitched = count('backup', 'flavor-stitched');
if (stitched > 0)
  console.log(`  flavor stitched   ${stitched} (a higher-quality flavor was mid-ad, fell through)`);
const matches = events.filter((e) => e.cat === 'backup' && e.ev === 'variant-match');
const downgrades = matches.filter((e) => e.data?.['exact'] !== true);
if (matches.length > 0) {
  console.log(
    `  variant matches   ${matches.length - downgrades.length} exact, ${downgrades.length} downgraded`,
  );
  for (const e of downgrades.slice(0, 5)) {
    const d = e.data ?? {};
    console.log(
      `    want ${d['target']} ${d['targetCodec']} → ${d['chosen']} ${d['chosenCodec']}  offered [${d['offered']}]`,
    );
  }
}

const reloads = events.filter((e) => e.cat === 'player' && e.ev === 'reload');
console.log(`\nplayer:`);
for (const action of ['ivs-load', 'ivs-load-fresh', 'ivs-not-found', 'ivs-load-threw']) {
  const n = reloads.filter((e) => e.data?.['action'] === action).length;
  if (n > 0) console.log(`  reload → ${action.padEnd(16)} ${n}`);
}
const mints = events.filter((e) => e.cat === 'player' && e.ev === 'mint');
if (mints.length > 0) {
  const byFlavor = new Map<string, number>();
  for (const m of mints) {
    const f = String(m.data?.['flavor']);
    byFlavor.set(f, (byFlavor.get(f) ?? 0) + 1);
  }
  console.log(`  mint flavors      ${[...byFlavor].map(([f, n]) => `${f}×${n}`).join('  ')}`);
}
const qrestores = events.filter((e) => e.cat === 'player' && e.ev === 'quality-restore');
for (const q of qrestores) {
  const d = q.data ?? {};
  console.log(`  quality-restore   ${d['mode']}${d['to'] ? `  ${d['to']}` : ''}`);
}
const verifies = events.filter((e) => e.cat === 'player' && e.ev === 'flush-verify');
const deadFlushes = verifies.filter((e) => e.data?.['action'] === 'DEAD').length;
if (verifies.length > 0)
  console.log(`  flush verify      ${verifies.length - deadFlushes} ok, ${deadFlushes} DEAD`);
const hlsErrors = events.filter((e) => e.ev === 'hls-status');
if (hlsErrors.length > 0) {
  console.log(`  hls non-200       ${hlsErrors.length}`);
  for (const e of hlsErrors.slice(0, 5)) {
    const d = e.data ?? {};
    console.log(`    ${d['status']}  ${d['isMaster'] ? 'master' : 'media '}  ${d['url']}`);
  }
}
console.log(`  video found/lost  ${count('player', 'video-found')}/${count('player', 'video-lost')}`);

console.log(`\nother signals:`);
console.log(
  `  ad redirects (empty mp4)  fetch ${count('fetch', 'ad-redirect')}  worker ${count('worker', 'ad-redirect')}`,
);
console.log(`  process errors            ${count('hls', 'process-error')}`);
console.log(`  worker m3u8 timeouts      ${count('worker', 'm3u8-timeout')}`);
console.log(`  worker fail-open          ${count('worker', 'fail-open')}`);
console.log(`  stream evictions          ${count('stream', 'evicted')}`);
console.log(`  workers not intercepted   ${count('worker', 'not-intercepted')}`);
const passthrough = [
  ...new Set(
    events.filter((e) => e.cat === 'poll' && e.ev === 'passthrough').map((e) => String(e.data?.['url'])),
  ),
];
const unmatched = events.filter((e) => e.cat === 'master' && e.ev === 'unmatched');
if (passthrough.length + unmatched.length > 0) {
  console.log(
    `  unattributed playlists    ${unmatched.length} master, ${passthrough.length} media (served untouched)`,
  );
  for (const e of unmatched) console.log(`    master  ${String(e.data?.['url'])}`);
  for (const url of passthrough) console.log(`    media   ${url}`);
}

const hintPolls = decisions.filter((e) => {
  const d = e.data?.['digest'] as { prefetch?: number; preloadHints?: number; parts?: number } | undefined;
  return (d?.prefetch ?? 0) + (d?.preloadHints ?? 0) + (d?.parts ?? 0) > 0;
});
console.log(
  `  polls carrying LL hints   ${hintPolls.length}/${decisions.length}${hintPolls.length > 0 ? '  ← low-latency HLS IS in use here; re-check hint handling on clean polls' : ''}`,
);
