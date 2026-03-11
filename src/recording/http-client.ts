/**
 * @module 08-io-recording
 * @spec spec/08-io-recording.md
 * @dependencies types.ts, io-event-buffer.ts, als-manager.ts, request-tracker.ts, body-capture.ts, header-filter.ts
 */

import type { IncomingMessage, ClientRequest } from 'node:http';

import type { IOEventSlot, RequestContext, ResolvedConfig } from '../types';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number): void;
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
}

interface BodyCaptureLike {
  captureClientResponse(
    res: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
}

interface HeaderFilterLike {
  filterHeaders(headers: Record<string, string>): Record<string, string>;
}

function toDurationMs(startTime: bigint, endTime: bigint): number {
  return Number(endTime - startTime) / 1_000_000;
}

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .join(', ');
  }

  return null;
}

function copyHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const copied: Record<string, string> = {};

  if (headers === undefined) {
    return copied;
  }

  for (const [key, value] of Object.entries(headers)) {
    const normalized = normalizeHeaderValue(value);

    if (normalized !== null) {
      copied[key] = normalized;
    }
  }

  return copied;
}

function getRequestHeaders(request: ClientRequest): Record<string, string> {
  const getHeaders = request as unknown as {
    getHeaders?: () => Record<string, unknown>;
  };

  return copyHeaders(getHeaders.getHeaders?.());
}

function buildTarget(request: ClientRequest): {
  target: string;
  method: string | null;
  url: string | null;
} {
  const requestRecord = request as unknown as Record<string, unknown>;
  const method = typeof requestRecord.method === 'string' ? requestRecord.method : null;
  const protocolValue =
    typeof requestRecord.protocol === 'string'
      ? requestRecord.protocol
      : typeof (requestRecord.agent as { protocol?: unknown } | undefined)?.protocol ===
          'string'
        ? ((requestRecord.agent as { protocol: string }).protocol)
        : 'http:';
  const protocol = protocolValue.endsWith(':') ? protocolValue : `${protocolValue}:`;
  const host =
    typeof requestRecord.host === 'string'
      ? requestRecord.host
      : typeof request.getHeader === 'function'
        ? (request.getHeader('host') as string | undefined) ?? 'unknown'
        : 'unknown';
  const port =
    typeof requestRecord.port === 'number'
      ? requestRecord.port
      : typeof requestRecord.port === 'string'
        ? requestRecord.port
        : '';
  const path = typeof requestRecord.path === 'string' ? requestRecord.path : '';
  const hostWithPort =
    port === '' || host.includes(':') ? host : `${host}:${String(port)}`;
  const url = `${protocol}//${hostWithPort}${path}`;

  return {
    target: `${protocol}//${hostWithPort}`,
    method,
    url
  };
}

function extractFd(socket: unknown): number | null {
  const maybeFd = (socket as { _handle?: { fd?: unknown } } | undefined)?._handle?.fd;

  return typeof maybeFd === 'number' ? maybeFd : null;
}

export class HttpClientRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly headerFilter: HeaderFilterLike;

  private readonly config: ResolvedConfig;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    bodyCapture: BodyCaptureLike;
    headerFilter: HeaderFilterLike;
    config: ResolvedConfig;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.bodyCapture = deps.bodyCapture;
    this.headerFilter = deps.headerFilter;
    this.config = deps.config;
  }

  public handleRequestStart(message: { request: ClientRequest }): void {
    try {
      if (message.request === undefined) {
        return;
      }

      const request = message.request;
      const context = this.als.getContext();
      const target = buildTarget(request);
      const { slot, seq } = this.buffer.push({
        phase: 'active',
        startTime: process.hrtime.bigint(),
        endTime: null,
        durationMs: null,
        type: 'http-client',
        direction: 'outbound',
        requestId: context?.requestId ?? null,
        contextLost: context === undefined,
        target: target.target,
        method: target.method,
        url: target.url,
        statusCode: null,
        fd: extractFd((request as unknown as { socket?: unknown }).socket),
        requestHeaders: this.headerFilter.filterHeaders(getRequestHeaders(request)),
        responseHeaders: null,
        requestBody: null,
        responseBody: null,
        requestBodyTruncated: false,
        responseBodyTruncated: false,
        requestBodyOriginalSize: null,
        responseBodyOriginalSize: null,
        error: null,
        aborted: false
      });

      context?.ioEvents.push(slot);

      let finalized = false;
      const finalize = (input?: { aborted?: boolean; error?: Error }): void => {
        if (finalized) {
          return;
        }

        finalized = true;
        slot.aborted = input?.aborted ?? false;
        slot.error =
          input?.error === undefined
            ? slot.error
            : { type: input.error.name, message: input.error.message };
        slot.endTime = process.hrtime.bigint();
        slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
        slot.phase = 'done';
      };

      request.on('response', (response) => {
        slot.statusCode = response.statusCode ?? null;
        slot.responseHeaders = this.headerFilter.filterHeaders(
          copyHeaders(response.headers as Record<string, unknown>)
        );
        this.bodyCapture.captureClientResponse(response, slot, seq, (oldBytes, newBytes) => {
          this.buffer.updatePayloadBytes(oldBytes, newBytes);
        });
        response.on('end', () => {
          finalize();
        });
      });

      request.on('error', (error) => {
        finalize(error instanceof Error ? { error } : undefined);
      });

      request.on('abort', () => {
        finalize({ aborted: true });
      });

      request.on('close', () => {
        if (!finalized && slot.statusCode === null) {
          finalize({ aborted: true });
        }
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record outbound HTTP request: ${messageText}`);
    }
  }

  public shutdown(): void {
    void this.config;
  }
}
