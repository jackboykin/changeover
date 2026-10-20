import type { ChannelStreamInfo, GQLHeaders } from '../types';
import { PLAYBACK_ACCESS_TOKEN_HASH, GQL_URL, USHER_BASE_URL } from '../utils/constants';

export interface TokenFlavor {
  playerType: string;
  platform: string;
}

export const SITE_FLAVOR: TokenFlavor = { playerType: 'site', platform: 'web' };

export type UsherTarget = Pick<ChannelStreamInfo, 'channelName' | 'usherParams' | 'isUsherV2'>;

export async function mintUsherUrl(
  { channelName, usherParams, isUsherV2 }: UsherTarget,
  headers: GQLHeaders,
  realFetch: typeof fetch,
  flavor: TokenFlavor,
): Promise<string | null> {
  const token = await fetchAccessToken(channelName, headers, realFetch, flavor);
  if (!token) return null;

  const url = new URL(
    `${USHER_BASE_URL}${isUsherV2 ? 'v2/' : ''}channel/hls/${channelName}.m3u8${usherParams}`,
  );
  url.searchParams.set('sig', token.sig);
  url.searchParams.set('token', token.token);
  return url.href;
}

async function fetchAccessToken(
  channelName: string,
  h: GQLHeaders,
  realFetch: typeof fetch,
  flavor: TokenFlavor,
): Promise<{ sig: string; token: string } | null> {
  const headers: Record<string, string> = {
    'Client-ID': h.clientId,
    'Content-Type': 'application/json',
  };
  if (h.deviceId) headers['X-Device-Id'] = h.deviceId;
  if (h.authorization) headers['Authorization'] = h.authorization;
  if (h.integrity) headers['Client-Integrity'] = h.integrity;
  if (h.version) headers['Client-Version'] = h.version;
  if (h.session) headers['Client-Session-Id'] = h.session;

  const resp = await realFetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationName: 'PlaybackAccessToken',
      variables: {
        isLive: true,
        login: channelName,
        isVod: false,
        vodID: '',
        playerType: flavor.playerType,
        platform: flavor.platform,
      },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: h.accessTokenHash ?? PLAYBACK_ACCESS_TOKEN_HASH },
      },
    }),
  });
  if (resp.status !== 200) return null;

  const json = (await resp.json()) as {
    data?: { streamPlaybackAccessToken?: { signature: string; value: string } };
  };
  const token = json.data?.streamPlaybackAccessToken;
  return token ? { sig: token.signature, token: token.value } : null;
}
