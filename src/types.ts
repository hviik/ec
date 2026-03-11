/**
 * @module 01-types-and-config
 * @spec spec/01-types-and-config.md
 * @dependencies none
 */

export type IOEventPhase = 'active' | 'done';

export type IOEventType =
  | 'http-server'
  | 'http-client'
  | 'undici'
  | 'db-query'
  | 'dns'
  | 'tcp'
  | 'cache-read';

export type IODirection = 'inbound' | 'outbound';

export interface IOEventSlot {
  seq: number;
  phase: IOEventPhase;
  startTime: bigint;
  endTime: bigint | null;
  durationMs: number | null;
  type: IOEventType;
  direction: IODirection;
  requestId: string | null;
  contextLost: boolean;
  target: string;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  fd: number | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  requestBody: Buffer | null;
  responseBody: Buffer | null;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
  requestBodyOriginalSize: number | null;
  responseBodyOriginalSize: number | null;
  error: { type: string; message: string } | null;
  aborted: boolean;
  estimatedBytes: number;
}

export interface RequestContext {
  requestId: string;
  startTime: bigint;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
  bodyTruncated: boolean;
  ioEvents: IOEventSlot[];
  stateReads: StateRead[];
}

export interface StateRead {
  container: string;
  operation: string;
  key: unknown;
  value: unknown;
  timestamp: bigint;
}

export interface CapturedFrame {
  functionName: string;
  filePath: string;
  lineNumber: number;
  columnNumber: number;
  locals: Record<string, unknown>;
}

export interface Completeness {
  requestCaptured: boolean;
  requestBodyTruncated: boolean;
  ioTimelineCaptured: boolean;
  ioEventsDropped: number;
  ioPayloadsTruncated: number;
  alsContextAvailable: boolean;
  localVariablesCaptured: boolean;
  localVariablesTruncated: boolean;
  stateTrackingEnabled: boolean;
  stateReadsCaptured: boolean;
  concurrentRequestsCaptured: boolean;
  piiScrubbed: boolean;
  encrypted: boolean;
  captureFailures: string[];
}

export interface ErrorInfo {
  type: string;
  message: string;
  stack: string;
  cause?: ErrorInfo;
  properties: Record<string, unknown>;
}

export interface IOEventSerialized {
  seq: number;
  type: IOEventSlot['type'];
  direction: IOEventSlot['direction'];
  target: string;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  fd: number | null;
  requestId: string | null;
  contextLost: boolean;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  requestBody: unknown | null;
  responseBody: unknown | null;
  requestBodyTruncated: boolean;
  responseBodyTruncated: boolean;
  requestBodyOriginalSize: number | null;
  responseBodyOriginalSize: number | null;
  error: { type: string; message: string } | null;
  aborted: boolean;
}

export interface StateReadSerialized {
  container: string;
  operation: string;
  key: unknown;
  value: unknown;
  timestamp: string;
}

export interface RequestSummary {
  requestId: string;
  method: string;
  url: string;
  startTime: string;
}

export interface ProcessMetadata {
  nodeVersion: string;
  v8Version: string;
  platform: string;
  arch: string;
  pid: number;
  uptime: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  activeHandles: number;
  activeRequests: number;
  eventLoopLagMs: number;
}

export interface ErrorPackage {
  schemaVersion: '1.0.0';
  capturedAt: string;
  error: {
    type: string;
    message: string;
    stack: string;
    cause?: ErrorInfo;
    properties: Record<string, unknown>;
  };
  localVariables?: CapturedFrame[];
  request?: {
    id: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | object;
    bodyTruncated?: boolean;
    receivedAt: string;
  };
  ioTimeline: IOEventSerialized[];
  stateReads: StateReadSerialized[];
  concurrentRequests: RequestSummary[];
  processMetadata: ProcessMetadata;
  codeVersion: { gitSha?: string; packageVersion?: string };
  environment: Record<string, string>;
  completeness: Completeness;
}

export interface SerializationLimits {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
  maxPayloadSize: number;
  maxTotalPackageSize: number;
}

export type TransportConfig =
  | { type: 'stdout' }
  | { type: 'file'; path: string; maxSizeBytes?: number }
  | {
      type: 'http';
      url: string;
      apiKey?: string;
      timeoutMs?: number;
      retries?: number;
    };

export interface SDKConfig {
  bufferSize?: number;
  bufferMaxBytes?: number;
  maxPayloadSize?: number;
  maxConcurrentRequests?: number;
  rateLimitPerMinute?: number;
  headerAllowlist?: string[];
  headerBlocklist?: RegExp[];
  envAllowlist?: string[];
  envBlocklist?: RegExp[];
  encryptionKey?: string;
  transport?: TransportConfig;
  captureLocalVariables?: boolean;
  captureDbBindParams?: boolean;
  captureBody?: boolean;
  piiScrubber?: (key: string, value: unknown) => unknown;
  replaceDefaultScrubber?: boolean;
  serialization?: Partial<SerializationLimits>;
  maxLocalsCollectionsPerSecond?: number;
  maxCachedLocals?: number;
  maxLocalsFrames?: number;
  allowInsecureTransport?: boolean;
}

export interface ResolvedConfig {
  bufferSize: number;
  bufferMaxBytes: number;
  maxPayloadSize: number;
  maxConcurrentRequests: number;
  rateLimitPerMinute: number;
  headerAllowlist: string[];
  headerBlocklist: RegExp[];
  envAllowlist: string[];
  envBlocklist: RegExp[];
  encryptionKey: string | undefined;
  transport: TransportConfig;
  captureLocalVariables: boolean;
  captureDbBindParams: boolean;
  captureBody: boolean;
  piiScrubber: ((key: string, value: unknown) => unknown) | undefined;
  replaceDefaultScrubber: boolean;
  serialization: SerializationLimits;
  maxLocalsCollectionsPerSecond: number;
  maxCachedLocals: number;
  maxLocalsFrames: number;
  allowInsecureTransport: boolean;
}
