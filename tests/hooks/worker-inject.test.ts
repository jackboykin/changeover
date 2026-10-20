import { describe, it, expect, mock } from 'bun:test';
import { buildWorkerInjectionCode } from '../../src/hooks/worker-inject';

describe('Executed code behavior', () => {
  function createMockWorkerScope() {
    const messages: unknown[] = [];
    const messageListeners: ((e: { data: unknown }) => void)[] = [];
    const scope: Record<string, unknown> = {
      self: null as unknown,
      addEventListener: mock((type: string, listener: (e: { data: unknown }) => void) => {
        if (type === 'message') messageListeners.push(listener);
      }),
      postMessage: mock((data: unknown) => messages.push(data)),
      fetch: mock(async (_input: RequestInfo | URL, _options?: RequestInit) => {
        return new Response('ok');
      }),
      Request: globalThis.Request,
      Response: globalThis.Response,
      Set: globalThis.Set,
      Map: globalThis.Map,
      Promise: globalThis.Promise,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    scope.self = scope;
    return { scope, messages, messageListeners };
  }

  it('worker posts WorkerReady after initialization', () => {
    const { scope, messages } = createMockWorkerScope();
    const code = buildWorkerInjectionCode();

    const fn = new Function(...Object.keys(scope), code);
    fn(...Object.values(scope));

    const readyMsg = messages.find((m) => (m as { key: string }).key === 'WorkerReady');
    expect(readyMsg).toBeDefined();
    expect((readyMsg as { key: string }).key).toBe('WorkerReady');
  });

  it('ad segment URLs are redirected to empty MP4', async () => {
    const { scope, messageListeners } = createMockWorkerScope();

    const fetchedUrls: string[] = [];
    const originalFetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      fetchedUrls.push(url);
      return new Response('ok');
    });
    scope.fetch = originalFetch;

    const code = buildWorkerInjectionCode();
    const fn = new Function(...Object.keys(scope), code);
    fn(...Object.values(scope));

    const adUrl = 'https://ad-server.example.com/ad-segment.ts';
    for (const listener of messageListeners) {
      listener({ data: { key: 'M3U8Response', id: 'none', text: '', adUrls: [adUrl] } });
    }

    const hookedFetch = scope.fetch as typeof fetch;
    await hookedFetch(adUrl);

    const lastFetchedUrl = fetchedUrls[fetchedUrls.length - 1];
    expect(lastFetchedUrl).toContain('data:video/mp4;base64,');
  });

  it('M3U8 URLs trigger M3U8Request message to main thread', async () => {
    const { scope, messages } = createMockWorkerScope();

    scope.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('.m3u8')) {
        return new Response('#EXTM3U\n#EXTINF:2.000,\nseg.ts', { status: 200 });
      }
      return new Response('ok');
    });

    const code = buildWorkerInjectionCode();
    const fn = new Function(...Object.keys(scope), code);
    fn(...Object.values(scope));

    messages.length = 0;

    void (scope.fetch as typeof fetch)('https://video-edge.example.com/media.m3u8');

    await new Promise((r) => setTimeout(r, 10));

    const m3u8Msg = messages.find((m) => (m as { key: string }).key === 'M3U8Request');
    expect(m3u8Msg).toBeDefined();
    expect((m3u8Msg as { key: string; url: string }).url).toContain('.m3u8');
  });

  it('non-M3U8 URLs pass through to realFetch', async () => {
    const { scope, messages } = createMockWorkerScope();
    const realFetchMock = mock(async () => new Response('real response'));
    scope.fetch = realFetchMock;

    const code = buildWorkerInjectionCode();
    const fn = new Function(...Object.keys(scope), code);
    fn(...Object.values(scope));

    messages.length = 0;

    const response = await (scope.fetch as typeof fetch)('https://example.com/some-resource.js');
    const text = await response.text();
    expect(text).toBe('real response');

    const m3u8Msg = messages.find((m) => (m as { key: string }).key === 'M3U8Request');
    expect(m3u8Msg).toBeUndefined();
  });

  it('preserves Request input when fetching intercepted M3U8 URLs', async () => {
    const { scope, messages, messageListeners } = createMockWorkerScope();
    const seenInputs: Array<RequestInfo | URL> = [];
    scope.fetch = mock(async (input: RequestInfo | URL) => {
      seenInputs.push(input);
      return new Response('#EXTM3U\n#EXTINF:2.000,\nseg.ts', { status: 200 });
    });

    const code = buildWorkerInjectionCode();
    const fn = new Function(...Object.keys(scope), code);
    fn(...Object.values(scope));

    messages.length = 0;
    const req = new Request('https://video-edge.example.com/live.m3u8', { method: 'GET' });
    const fetchPromise = (scope.fetch as typeof fetch)(req);
    await new Promise((r) => setTimeout(r, 10));

    const m3u8Msg = messages.find((m) => (m as { key?: string }).key === 'M3U8Request') as
      | { id: string }
      | undefined;
    expect(m3u8Msg).toBeDefined();

    for (const listener of messageListeners) {
      listener({
        data: {
          key: 'M3U8Response',
          id: m3u8Msg!.id,
          text: '#EXTM3U\n#processed',
        },
      });
    }

    await fetchPromise;
    expect(seenInputs[0]).toBe(req);
  });
});
