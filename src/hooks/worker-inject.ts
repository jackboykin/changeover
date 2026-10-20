import { EMPTY_MP4_DATA_URI } from '../utils/constants';
import { classifyHlsUrl, urlShape } from '../utils/url';

// Runs in the worker from its source text, so it can only use its arguments.
function workerMain(emptyMp4: string, classify: typeof classifyHlsUrl, shape: typeof urlShape): void {
  const ws = self as unknown as {
    addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
    postMessage(data: unknown): void;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
  let adSegmentUrls = new Set<string>();
  const pendingM3U8Requests = new Map<string, (text: string) => void>();
  let nextRequestId = 0;

  ws.addEventListener('message', (e: MessageEvent) => {
    const data = e.data;
    if (data?.key !== 'M3U8Response') return;
    if (data.adUrls) adSegmentUrls = new Set(data.adUrls as string[]);
    const id = data.id as string;
    const pending = pendingM3U8Requests.get(id);
    if (pending) {
      pendingM3U8Requests.delete(id);
      pending(data.text as string);
    }
  });

  function traceUp(ev: string, data?: Record<string, unknown>): void {
    ws.postMessage({ key: 'TraceEvent', cat: 'worker', ev, data });
  }

  function requestM3U8Processing(url: string, text: string, isMaster: boolean): Promise<string> {
    return new Promise((resolve) => {
      const id = 'r' + ++nextRequestId;
      const timer = setTimeout(() => {
        if (pendingM3U8Requests.delete(id)) {
          traceUp('m3u8-timeout', { isMaster, url: shape(url) });
          resolve(text);
        }
      }, 10000);
      pendingM3U8Requests.set(id, (result: string) => {
        clearTimeout(timer);
        resolve(result);
      });
      ws.postMessage({ key: 'M3U8Request', id, url, text, isMaster });
    });
  }

  const realFetch = ws.fetch.bind(ws);
  ws.fetch = async (urlArg: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const rawUrl = urlArg instanceof Request ? urlArg.url : String(urlArg);
    const url = rawUrl.trimEnd();

    if (adSegmentUrls.has(url)) {
      traceUp('ad-redirect', { url: shape(url) });
      return realFetch(emptyMp4, options);
    }

    const { isHls, isMaster } = classify(url);
    if (!isHls) return realFetch(urlArg, options);

    const response = await realFetch(typeof urlArg === 'string' ? url : urlArg, options);
    if (response.status !== 200) {
      traceUp('hls-status', { isMaster, status: response.status, url: shape(url) });
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');
    const text = await response.text();
    const processed = await requestM3U8Processing(url, text, isMaster);
    return new Response(processed, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  ws.postMessage({ key: 'WorkerReady' });
}

export function buildWorkerInjectionCode(): string {
  return `(${workerMain})(${JSON.stringify(EMPTY_MP4_DATA_URI)}, ${classifyHlsUrl}, ${urlShape});`;
}
