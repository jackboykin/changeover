import { installFetchHook, getGQLHeaders } from './hooks/fetch-hook';
import { installWorkerHook } from './hooks/worker-hook';
import { M3U8Processor } from './hls/m3u8-processor';
import { setFreshPathMint } from './player/player';
import { installObserver } from './player/observer';
import { installTraceExport } from './trace';

// A second copy of the script (installed twice, or an old version beside a new one) shares this
// page, and would chain a second fetch hook and inject the worker twice.
const INSTALLED = Symbol.for('changeover.installed');
const g = globalThis as unknown as Record<symbol, true | undefined>;

if (!g[INSTALLED]) {
  g[INSTALLED] = true;
  const processor = new M3U8Processor(getGQLHeaders, window.fetch.bind(window));
  setFreshPathMint((channel) => processor.mintSitePath(channel));
  installFetchHook(processor);
  installWorkerHook(processor);
  installTraceExport();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installObserver, { once: true });
  } else {
    installObserver();
  }
}
