import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { WorkerMessage } from '../../src/types';
import { installWorkerHook } from '../../src/hooks/worker-hook';
import type { M3U8Processor } from '../../src/hls/m3u8-processor';

type Listener = (event: { data?: unknown }) => void;

class FakeWorker {
  url: string;
  options: WorkerOptions | undefined;
  postedMessages: unknown[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = String(url);
    this.options = options;
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(data: unknown): void {
    this.postedMessages.push(data);
  }

  emit(type: string, data?: unknown): void {
    const event = { data };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('worker-hook integration', () => {
  const g = globalThis as unknown as {
    window?: {
      Worker: typeof Worker;
      location: { href: string };
    };
  };

  const originalWindow = g.window;
  const originalXMLHttpRequest = globalThis.XMLHttpRequest;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  let xhrBehavior: {
    status: number;
    responseText: string;
    throwOnSend: boolean;
  };
  const xhrOpenCalls: Array<{ method: string; url: string; async: boolean }> = [];
  let createObjectURLMock: ReturnType<typeof mock>;
  let revokeObjectURLMock: ReturnType<typeof mock>;

  class FakeXMLHttpRequest {
    status = 0;
    responseText = '';

    open(method: string, url: string, async = true): void {
      xhrOpenCalls.push({ method, url, async });
    }

    send(): void {
      if (xhrBehavior.throwOnSend) {
        throw new Error('inline failed');
      }
      this.status = xhrBehavior.status;
      this.responseText = xhrBehavior.responseText;
    }
  }

  beforeEach(() => {
    xhrBehavior = {
      status: 200,
      responseText: 'self.__blobWorkerTestSource = true;',
      throwOnSend: false,
    };
    xhrOpenCalls.length = 0;

    createObjectURLMock = mock(() => `blob:worker-${Math.random().toString(16).slice(2)}`);
    revokeObjectURLMock = mock(() => {});
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURLMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURLMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: FakeXMLHttpRequest as unknown as typeof XMLHttpRequest,
      configurable: true,
      writable: true,
    });

    g.window = {
      Worker: FakeWorker as unknown as typeof Worker,
      location: { href: 'https://www.twitch.tv/some-channel' },
    };

    installWorkerHook({
      serve: async (_url: string, text: string, isMaster: boolean) =>
        `${text}\n#${isMaster ? 'master' : 'media'}-processed`,
      getAdSegmentUrls: () => ['https://ads.example.com/ad.ts'],
    } as unknown as M3U8Processor);
  });

  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: originalCreateObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: originalRevokeObjectURL,
      configurable: true,
      writable: true,
    });
    if (originalXMLHttpRequest) {
      Object.defineProperty(globalThis, 'XMLHttpRequest', {
        value: originalXMLHttpRequest,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    }

    if (originalWindow) {
      g.window = originalWindow;
    } else {
      delete g.window;
    }
  });

  it('intercepts Twitch workers by injecting a blob URL', () => {
    const worker = new g.window!.Worker('https://static.twitch.tv/workers/site.js') as unknown as FakeWorker;

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(worker.url.startsWith('blob:worker-')).toBe(true);
  });

  it('does not intercept non-Twitch workers', () => {
    const worker = new g.window!.Worker('https://example.com/worker.js') as unknown as FakeWorker;

    expect(worker.url).toBe('https://example.com/worker.js');
    expect(createObjectURLMock).toHaveBeenCalledTimes(0);
  });

  it('does not intercept Twitch module workers (compatibility fallback)', () => {
    const worker = new g.window!.Worker('https://static.twitch.tv/workers/site.js', {
      type: 'module',
    }) as unknown as FakeWorker;

    expect(worker.url).toBe('https://static.twitch.tv/workers/site.js');
    expect(createObjectURLMock).toHaveBeenCalledTimes(0);
  });

  it('intercepts root-domain Twitch workers (twitch.tv)', () => {
    const worker = new g.window!.Worker('https://twitch.tv/workers/site.js') as unknown as FakeWorker;

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(worker.url.startsWith('blob:worker-')).toBe(true);
  });

  it('intercepts Twitch blob workers by inlining source first', () => {
    const blobUrl = 'blob:https://www.twitch.tv/1234-blob-worker';

    const worker = new g.window!.Worker(blobUrl) as unknown as FakeWorker;

    expect(xhrOpenCalls).toHaveLength(1);
    expect(xhrOpenCalls[0]).toEqual({ method: 'GET', url: blobUrl, async: false });
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(worker.url.startsWith('blob:worker-')).toBe(true);
  });

  it('fails open for Twitch blob workers when source inlining fails', () => {
    xhrBehavior.throwOnSend = true;

    const blobUrl = 'blob:https://www.twitch.tv/5678-blob-worker';

    const worker = new g.window!.Worker(blobUrl) as unknown as FakeWorker;

    expect(xhrOpenCalls).toHaveLength(1);
    expect(createObjectURLMock).toHaveBeenCalledTimes(0);
    expect(worker.url).toBe(blobUrl);
  });

  it('revokes the blob URL once the worker is ready', () => {
    const worker = new g.window!.Worker('https://player.twitch.tv/worker.js') as unknown as FakeWorker;
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
    worker.emit('message', { key: 'WorkerReady' } as WorkerMessage);
    expect(revokeObjectURLMock).toHaveBeenCalledWith(worker.url);
  });

  it('routes M3U8Request through processor and posts M3U8Response', async () => {
    const worker = new g.window!.Worker('https://static.twitch.tv/workers/site.js') as unknown as FakeWorker;
    worker.emit('message', { key: 'WorkerReady' } as WorkerMessage);

    worker.emit('message', {
      key: 'M3U8Request',
      id: 'r1',
      url: 'https://video-edge.example.com/media.m3u8',
      text: '#EXTM3U',
      isMaster: false,
    } as WorkerMessage);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.postedMessages).toEqual([
      {
        key: 'M3U8Response',
        id: 'r1',
        text: '#EXTM3U\n#media-processed',
        adUrls: ['https://ads.example.com/ad.ts'],
      },
    ]);
  });
});
