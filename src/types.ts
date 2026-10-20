export interface GQLHeaders {
  clientId: string;
  deviceId: string | null;
  authorization: string | null;
  integrity: string | null;
  version: string | null;
  session: string | null;
  accessTokenHash: string | null;
}

export interface StreamVariant {
  url: string;
  resolution: string;
  width: number;
  height: number;
  frameRate: number;
  codecs: string;
  isHEVC: boolean;
}

export interface ChannelStreamInfo {
  channelName: string;
  lastSeenAt: number;
  isUsherV2: boolean;
  usherParams: string;
  variants: Record<string, StreamVariant>;
  break: AdBreak | null;
}

interface AdBreak {
  id: number;
  startedAt: number;
  codec: string;
  isHEVC: boolean;
  seam: boolean;
  polls: number;
  backupHits: number;
  backupMisses: number;
}

export type WorkerMessage =
  | { key: 'WorkerReady' }
  | { key: 'M3U8Request'; id: string; url: string; text: string; isMaster: boolean }
  | { key: 'TraceEvent'; cat: string; ev: string; data?: Record<string, unknown> };

export interface MainToWorkerMessage {
  key: 'M3U8Response';
  id: string;
  text: string;
  adUrls?: string[];
}

export interface IVSQuality {
  name?: string;
  [key: string]: unknown;
}

export interface IVSPlayer {
  load: (url?: string) => void;
  getPath: () => string;
  play: () => void;
  getQuality?: () => IVSQuality | null | undefined;
  setQuality?: (quality: IVSQuality, adaptive?: boolean) => void;
  isAutoQualityMode?: () => boolean;
  setAutoQualityMode?: (enabled: boolean) => void;
}
