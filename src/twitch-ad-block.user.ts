import { installFetchHook, getGQLHeaders, setM3U8Processor } from './hooks/fetch-hook';
import { installWorkerHook, setWorkerProcessor } from './hooks/worker-hook';
import { M3U8Processor } from './hls/m3u8-processor';
import { installObserver } from './player/observer';
import { installTraceExport } from './trace';

const INSTALLED = Symbol.for('twitch-ad-block.installed');

function main(): void {
  const g = globalThis as unknown as Record<symbol, true>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  const realFetch = installFetchHook();
  installWorkerHook();

  const processor = new M3U8Processor(getGQLHeaders, realFetch);
  setM3U8Processor(processor);
  setWorkerProcessor(processor);

  const onReady = (): void => {
    installTraceExport();
    installObserver();
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onReady();
  } else {
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
  }
}

main();
