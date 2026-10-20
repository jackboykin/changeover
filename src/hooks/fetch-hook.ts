import type { GQLHeaders } from '../types';
import { TWITCH_CLIENT_ID, EMPTY_MP4_DATA_URI, GQL_URL } from '../utils/constants';
import type { M3U8Processor } from '../hls/m3u8-processor';
import { withBody } from '../utils/response';
import { normalizeUrl, classifyHlsUrl, urlShape } from '../utils/url';
import { trace } from '../trace';

const gqlHeaders: GQLHeaders = {
  clientId: TWITCH_CLIENT_ID,
  deviceId: null,
  authorization: null,
  integrity: null,
  version: null,
  session: null,
  accessTokenHash: null,
};

export function getGQLHeaders(): GQLHeaders {
  return { ...gqlHeaders };
}

export function installFetchHook(processor: M3U8Processor): void {
  const realFetch = window.fetch;

  window.fetch = function (this: typeof globalThis, input: RequestInfo | URL, init?: RequestInit) {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = normalizeUrl(rawUrl);

    if (url.startsWith(GQL_URL)) {
      const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : null);
      if (rawHeaders) captureHeaders(rawHeaders);
      const body = init?.body;
      if (typeof body === 'string') captureAccessTokenHash(body);
    }

    if (processor.adSegments.has(rawUrl)) {
      trace('fetch', 'ad-redirect', { url: urlShape(rawUrl) });
      return realFetch(EMPTY_MP4_DATA_URI);
    }

    const { isHls, isMaster } = classifyHlsUrl(url);
    if (!isHls) return realFetch.call(this, input, init);

    return realFetch.call(this, input, init).then(async (resp: Response) => {
      if (resp.status !== 200) {
        trace('fetch', 'hls-status', { isMaster, status: resp.status, url: urlShape(url) });
        return resp;
      }
      return withBody(resp, await processor.serve(url, await resp.text(), isMaster));
    });
  } as typeof fetch;
}

const HEADER_MAPPINGS: Record<string, keyof GQLHeaders> = {
  'X-Device-Id': 'deviceId',
  'Device-ID': 'deviceId',
  'Client-Version': 'version',
  'Client-Session-Id': 'session',
  'Client-Integrity': 'integrity',
  Authorization: 'authorization',
  'Client-ID': 'clientId',
};

function captureHeaders(raw: HeadersInit): void {
  const headers = new Headers(raw);
  for (const [headerName, field] of Object.entries(HEADER_MAPPINGS)) {
    const value = headers.get(headerName);
    if (typeof value === 'string') {
      if (gqlHeaders[field] == null) trace('gql', 'header-captured', { field });
      gqlHeaders[field] = value;
    }
  }
}

type GQLBody = {
  operationName?: unknown;
  extensions?: { persistedQuery?: { sha256Hash?: unknown } };
} | null;

function captureAccessTokenHash(body: string): void {
  try {
    const parsed = JSON.parse(body) as GQLBody;
    const hash = parsed?.extensions?.persistedQuery?.sha256Hash;
    if (parsed?.operationName !== 'PlaybackAccessToken' || typeof hash !== 'string') return;
    if (gqlHeaders.accessTokenHash == null) trace('gql', 'header-captured', { field: 'accessTokenHash' });
    gqlHeaders.accessTokenHash = hash;
  } catch {}
}
