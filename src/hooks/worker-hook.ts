import type { MainToWorkerMessage, WorkerMessage } from '../types';
import { buildWorkerInjectionCode } from './worker-inject';
import type { M3U8Processor } from '../hls/m3u8-processor';
import { trace } from '../trace';

let processor: M3U8Processor | null = null;

export function setWorkerProcessor(proc: M3U8Processor): void {
  processor = proc;
}

function isTwitchHostname(hostname: string): boolean {
  return hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv');
}

function getWorkerHostname(resolvedUrl: URL): string {
  if (resolvedUrl.protocol !== 'blob:') return resolvedUrl.hostname;

  const origin = resolvedUrl.origin;
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).hostname;
    } catch {}
  }
  return '';
}

function tryInlineBlobWorkerSource(workerUrl: string, injectionCode: string): string | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', workerUrl, false);
    xhr.send();
    if (xhr.status === 200 || xhr.status === 0) {
      return injectionCode + '\n' + xhr.responseText;
    }
  } catch {}
  return null;
}

export function installWorkerHook(): void {
  const OriginalWorker = window.Worker;

  const HookedWorker = class TwitchWorker extends OriginalWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      let host = '';
      let workerUrl = String(url);
      try {
        const resolved = new URL(workerUrl, window.location.href);
        workerUrl = resolved.href;
        host = getWorkerHostname(resolved);
      } catch {}
      const isTwitch = isTwitchHostname(host);

      if (!isTwitch || options?.type === 'module') {
        trace('worker', 'not-intercepted', { reason: isTwitch ? 'module-worker' : 'foreign-host', host });
        super(url, options);
        return;
      }

      // importScripts(blob:) can throw a NetworkError and strand the player, so blob sources are inlined.
      const injectionCode = buildWorkerInjectionCode();
      const isBlobWorker = workerUrl.startsWith('blob:');
      const modifiedSource = isBlobWorker
        ? tryInlineBlobWorkerSource(workerUrl, injectionCode)
        : injectionCode + '\nimportScripts(' + JSON.stringify(workerUrl) + ');\n';

      if (!modifiedSource) {
        trace('worker', 'fail-open', { blob: isBlobWorker });
        super(url, options);
        return;
      }

      trace('worker', 'intercepted', { blob: isBlobWorker });
      const blobUrl = URL.createObjectURL(new Blob([modifiedSource], { type: 'application/javascript' }));
      super(blobUrl, options);

      this.addEventListener('message', (e: MessageEvent) => handleWorkerMessage(e.data, this, blobUrl));
    }
  };

  Object.defineProperty(window, 'Worker', {
    get: () => HookedWorker,
    set: () => {},
    configurable: true,
  });
}

function handleWorkerMessage(msg: WorkerMessage, worker: Worker, blobUrl: string): void {
  switch (msg?.key) {
    case 'WorkerReady':
      trace('worker', 'ready', {});
      URL.revokeObjectURL(blobUrl);
      break;
    case 'TraceEvent':
      trace(msg.cat, msg.ev, msg.data);
      break;
    case 'M3U8Request':
      if (processor) void processM3U8Request(processor, msg, worker);
      break;
  }
}

async function processM3U8Request(
  proc: M3U8Processor,
  { id, url, text, isMaster }: Extract<WorkerMessage, { key: 'M3U8Request' }>,
  worker: Worker,
): Promise<void> {
  let processedText = text;
  try {
    processedText = isMaster
      ? proc.handleMasterPlaylist(url, text)
      : await proc.handleMediaPlaylist(url, text);
  } catch (err) {
    trace('worker', 'process-error', { isMaster, err: String(err) });
  }

  const reply: MainToWorkerMessage = { key: 'M3U8Response', id, text: processedText };
  if (!isMaster) reply.adUrls = proc.getAdSegmentUrls();
  worker.postMessage(reply);
}
