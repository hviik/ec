/**
 * @module 08-io-recording
 * @spec spec/08-io-recording.md
 * @dependencies types.ts, io-event-buffer.ts, als-manager.ts, request-tracker.ts, body-capture.ts, header-filter.ts
 */

import { channel } from 'node:diagnostics_channel';
import { Server } from 'node:http';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { IOEventSlot, RequestContext, ResolvedConfig } from '../types';
import { copyHeaders, extractFd, toDurationMs } from './utils';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
  updatePayloadBytes(oldBytes: number, newBytes: number): void;
}

interface ALSManagerLike {
  createRequestContext(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): RequestContext;
  runWithContext<T>(ctx: RequestContext, fn: () => T): T;
  getContext(): RequestContext | undefined;
  getStore(): AsyncLocalStorage<RequestContext>;
  releaseRequestContext?(ctx: RequestContext): void;
}

interface RequestTrackerLike {
  add(ctx: RequestContext): void;
  remove(requestId: string): void;
}

interface BodyCaptureLike {
  captureInboundRequest(
    req: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
  captureOutboundResponse(
    res: ServerResponse,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void;
  materializeContextBody(context: RequestContext): void;
  materializeSlotBodies(slot: IOEventSlot): void;
}

interface HeaderFilterLike {
  filterHeaders(headers: Record<string, string>): Record<string, string>;
}

interface ScrubberLike {
  scrubUrl(rawUrl: string): string;
}

interface BindStoreChannel {
  bindStore?: (
    store: AsyncLocalStorage<RequestContext>,
    transform: (message: { request?: IncomingMessage }) => RequestContext
  ) => void;
}

const RESPONSE_FINALIZER = Symbol('ecd.responseFinalizer');

type ResponseWithFinalizer = ServerResponse & {
  [RESPONSE_FINALIZER]?: RequestFinalizer;
  writableFinished?: boolean;
};

class RequestFinalizer {
  public slot!: IOEventSlot;

  public context!: RequestContext;

  public request!: IncomingMessage;

  public response!: ServerResponse;

  public requestTracker!: RequestTrackerLike;

  public als!: ALSManagerLike;

  public headerFilter!: HeaderFilterLike;

  public requestContexts!: WeakMap<object, RequestContext>;

  public pool!: RequestFinalizer[];

  public finalized = false;

  public initialize(input: {
    slot: IOEventSlot;
    context: RequestContext;
    request: IncomingMessage;
    response: ServerResponse;
    requestTracker: RequestTrackerLike;
    als: ALSManagerLike;
    headerFilter: HeaderFilterLike;
    requestContexts: WeakMap<object, RequestContext>;
    pool: RequestFinalizer[];
  }): this {
    this.slot = input.slot;
    this.context = input.context;
    this.request = input.request;
    this.response = input.response;
    this.requestTracker = input.requestTracker;
    this.als = input.als;
    this.headerFilter = input.headerFilter;
    this.requestContexts = input.requestContexts;
    this.pool = input.pool;
    this.finalized = false;
    return this;
  }

  public finalize(aborted: boolean): void {
    if (this.finalized) {
      return;
    }

    this.finalized = true;
    this.slot.aborted = aborted;
    this.slot.statusCode = this.response.statusCode ?? this.slot.statusCode;
    this.slot.responseHeaders = this.headerFilter.filterHeaders(
      copyHeaders(this.response.getHeaders() as Record<string, unknown>)
    );
    this.slot.endTime = process.hrtime.bigint();
    this.slot.durationMs = toDurationMs(this.slot.startTime, this.slot.endTime);
    this.slot.phase = 'done';
    this.context.body = this.slot.requestBody;
    this.context.bodyTruncated = this.slot.requestBodyTruncated;
    this.requestTracker.remove(this.context.requestId);
    this.requestContexts.delete(this.request);
    this.als.releaseRequestContext?.(this.context);
    this.response.removeListener('close', handleResponseClose);
    delete (this.response as ResponseWithFinalizer)[RESPONSE_FINALIZER];
    const pool = this.pool;
    this.reset();
    pool.push(this);
  }

  private reset(): void {
    this.finalized = false;
    this.slot = undefined as never;
    this.context = undefined as never;
    this.request = undefined as never;
    this.response = undefined as never;
    this.requestTracker = undefined as never;
    this.als = undefined as never;
    this.headerFilter = undefined as never;
    this.requestContexts = undefined as never;
    this.pool = undefined as never;
  }
}

function handleResponseClose(this: ServerResponse): void {
  const response = this as ResponseWithFinalizer;
  const finalizer = response[RESPONSE_FINALIZER];

  if (finalizer === undefined) {
    return;
  }

  finalizer.finalize(
    !((response.writableFinished ?? false) || response.writableEnded)
  );
}

export class HttpServerRecorder {
  private static readonly REQUEST_HEADER_CACHE_LIMIT = 4;

  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly requestTracker: RequestTrackerLike;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly headerFilter: HeaderFilterLike;

  private readonly scrubber: ScrubberLike;

  private readonly config: ResolvedConfig;

  private readonly requestContexts = new WeakMap<object, RequestContext>();

  private readonly requestHeaderCache = new Map<string, Record<string, string>>();

  private readonly originalServerEmit: typeof Server.prototype.emit;

  private readonly finalizerPool: RequestFinalizer[] = [];

  private bindStoreSucceeded = false;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    requestTracker: RequestTrackerLike;
    bodyCapture: BodyCaptureLike;
    headerFilter: HeaderFilterLike;
    scrubber: ScrubberLike;
    config: ResolvedConfig;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.requestTracker = deps.requestTracker;
    this.bodyCapture = deps.bodyCapture;
    this.headerFilter = deps.headerFilter;
    this.scrubber = deps.scrubber;
    this.config = deps.config;
    this.originalServerEmit = Server.prototype.emit;
  }

  public install(): void {
    this.tryBindStore();
    if (!this.bindStoreSucceeded) {
      this.installEmitPatch();
    }
  }

  public handleRequestStart(message: {
    request: IncomingMessage;
    response: ServerResponse;
    socket: Socket;
    server: Server;
  }): void {
    try {
      if (
        message.request === undefined ||
        message.response === undefined ||
        message.socket === undefined
      ) {
        return;
      }

      const request = message.request;
      const response = message.response;
      const socket = message.socket ?? request.socket;
      const context = this.als.getContext() ?? this.getOrCreateContext(request);

      this.requestTracker.add(context);

      const { slot, seq } = this.buffer.push({
        phase: 'active',
        startTime: context.startTime,
        endTime: null,
        durationMs: null,
        type: 'http-server',
        direction: 'inbound',
        requestId: context.requestId,
        contextLost: false,
        target: context.headers.host ?? 'http-server',
        method: context.method,
        url: context.url,
        statusCode: null,
        fd: extractFd(socket),
        requestHeaders: { ...context.headers },
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

      context.ioEvents.push(slot);

      const updatePayloadBytes = (oldBytes: number, newBytes: number) => {
        this.buffer.updatePayloadBytes(oldBytes, newBytes);
        context.bodyTruncated = slot.requestBodyTruncated;
      };

      this.bodyCapture.captureInboundRequest(request, slot, seq, updatePayloadBytes);
      this.bodyCapture.captureOutboundResponse(response, slot, seq, (oldBytes, newBytes) => {
        this.buffer.updatePayloadBytes(oldBytes, newBytes);
      });
      const finalizer = (this.finalizerPool.pop() ?? new RequestFinalizer()).initialize({
        slot,
        context,
        request,
        response,
        requestTracker: this.requestTracker,
        als: this.als,
        headerFilter: this.headerFilter,
        requestContexts: this.requestContexts,
        pool: this.finalizerPool
      });

      (response as ResponseWithFinalizer)[RESPONSE_FINALIZER] = finalizer;
      response.on('close', handleResponseClose);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record inbound HTTP request: ${messageText}`);
    }
  }

  public shutdown(): void {
    if (!this.bindStoreSucceeded) {
      Server.prototype.emit = this.originalServerEmit;
    }
  }

  private tryBindStore(): void {
    try {
      const requestStartChannel = channel(
        'http.server.request.start'
      ) as unknown as BindStoreChannel;

      if (typeof requestStartChannel.bindStore === 'function') {
        requestStartChannel.bindStore(this.als.getStore(), (message) => {
          if (message.request === undefined) {
            return this.als.createRequestContext({
              method: 'UNKNOWN',
              url: 'unknown',
              headers: {}
            });
          }

          return this.getOrCreateContext(message.request);
        });
        this.bindStoreSucceeded = true;
      }
    } catch {
      // Fall back to the emit patch below.
    }
  }

  private installEmitPatch(): void {
    const previousEmit = this.originalServerEmit as unknown as (
      this: Server,
      eventName: string,
      ...args: unknown[]
    ) => boolean;
    const recorder = this;

    Server.prototype.emit = (function (this: Server, eventName: string) {
      if (eventName !== 'request') {
        return Reflect.apply(previousEmit, this, arguments);
      }

      const request = arguments[1] as IncomingMessage | undefined;

      if (request === undefined) {
        return Reflect.apply(previousEmit, this, arguments);
      }

      const context = recorder.getOrCreateContext(request);

      return recorder.als.runWithContext(context, () =>
        Reflect.apply(previousEmit, this, arguments)
      );
    }) as typeof Server.prototype.emit;
  }

  private getOrCreateContext(request: IncomingMessage): RequestContext {
    const existing = this.requestContexts.get(request);

    if (existing !== undefined) {
      return existing;
    }

    const headers = this.getFilteredRequestHeaders(request.headers as Record<string, unknown>);
    const context = this.als.createRequestContext({
      method: request.method ?? 'UNKNOWN',
      url: request.url ?? '',
      headers
    });

    this.requestContexts.set(request, context);
    return context;
  }

  private getFilteredRequestHeaders(
    headers: Record<string, unknown>
  ): Record<string, string> {
    const cacheKey = this.getRequestHeaderCacheKey(headers);
    const cached = this.requestHeaderCache.get(cacheKey);

    if (cached !== undefined) {
      this.requestHeaderCache.delete(cacheKey);
      this.requestHeaderCache.set(cacheKey, cached);
      return cached;
    }

    const filtered = this.headerFilter.filterHeaders(copyHeaders(headers));
    this.requestHeaderCache.set(cacheKey, filtered);

    if (this.requestHeaderCache.size > HttpServerRecorder.REQUEST_HEADER_CACHE_LIMIT) {
      const oldestKey = this.requestHeaderCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        this.requestHeaderCache.delete(oldestKey);
      }
    }

    return filtered;
  }

  private getRequestHeaderCacheKey(headers: Record<string, unknown>): string {
    let key = '';

    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (headerValue === undefined) {
        continue;
      }

      const normalizedName = headerName.toLowerCase();
      if (Array.isArray(headerValue)) {
        key += `${normalizedName}=${headerValue.map((value) => String(value)).join(',')}\n`;
        continue;
      }

      key += `${normalizedName}=${String(headerValue)}\n`;
    }

    return key;
  }
}
