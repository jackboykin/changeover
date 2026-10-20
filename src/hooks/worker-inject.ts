import type { MainToWorkerMessage } from '../types';
import { EMPTY_MP4_DATA_URI } from '../utils/constants';
import { withBody } from '../utils/response';
import { classifyHlsUrl, urlShape } from '../utils/url';

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (e: MessageEvent<MainToWorkerMessage | undefined>) => void,
  ): void;
  postMessage(data: unknown): void;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// The worker's half of the playlist protocol: it hands each playlist to the page to process, and
// keeps the ad segment URLs the page sends back. Runs in the worker from its source text.
function connectToPage(ws: WorkerScope, shape: typeof urlShape) {
  let adSegmentUrls = new Set<string>();
  const pending = new Map<string, (text: string) => void>();
  let nextRequestId = 0;

  ws.addEventListener('message', ({ data }) => {
    if (data?.key !== 'M3U8Response') return;
    if (data.adUrls) adSegmentUrls = new Set(data.adUrls);
    pending.get(data.id)?.(data.text);
    pending.delete(data.id);
  });

  const trace = (ev: string, data?: Record<string, unknown>): void => {
    ws.postMessage({ key: 'TraceEvent', cat: 'worker', ev, data });
  };

  const process = (url: string, text: string, isMaster: boolean): Promise<string> =>
    new Promise((resolve) => {
      const id = `r${++nextRequestId}`;
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          trace('m3u8-timeout', { isMaster, url: shape(url) });
          resolve(text);
        }
      }, 10_000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      ws.postMessage({ key: 'M3U8Request', id, url, text, isMaster });
    });

  return { isAdSegment: (url: string) => adSegmentUrls.has(url), trace, process };
}

// Runs in the worker from its source text, so it can only use its arguments.
function workerMain(
  emptyMp4: string,
  classify: typeof classifyHlsUrl,
  shape: typeof urlShape,
  connect: typeof connectToPage,
  rebody: typeof withBody,
): void {
  const ws = self as unknown as WorkerScope;
  const page = connect(ws, shape);
  const realFetch = ws.fetch.bind(ws);

  ws.fetch = async (urlArg: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const rawUrl = urlArg instanceof Request ? urlArg.url : String(urlArg);
    const url = rawUrl.trimEnd();

    if (page.isAdSegment(url)) {
      page.trace('ad-redirect', { url: shape(url) });
      return realFetch(emptyMp4, options);
    }

    const { isHls, isMaster } = classify(url);
    if (!isHls) return realFetch(urlArg, options);

    const response = await realFetch(typeof urlArg === 'string' ? url : urlArg, options);
    if (response.status !== 200) {
      page.trace('hls-status', { isMaster, status: response.status, url: shape(url) });
      return response;
    }
    return rebody(response, await page.process(url, await response.text(), isMaster));
  };
  ws.postMessage({ key: 'WorkerReady' });
}

export function buildWorkerInjectionCode(): string {
  const args = [JSON.stringify(EMPTY_MP4_DATA_URI), classifyHlsUrl, urlShape, connectToPage, withBody];
  return `(${workerMain.toString()})(${args.map(String).join(', ')});`;
}
