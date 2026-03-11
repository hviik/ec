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
}

interface HeaderFilterLike {
  filterHeaders(headers: Record<string, string>): Record<string, string>;
}

interface BindStoreChannel {
  bindStore?: (
    store: AsyncLocalStorage<RequestContext>,
    transform: (message: { request?: IncomingMessage }) => RequestContext
  ) => void;
}

export class HttpServerRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly requestTracker: RequestTrackerLike;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly headerFilter: HeaderFilterLike;

  private readonly config: ResolvedConfig;

  private readonly requestContexts = new WeakMap<object, RequestContext>();

  private readonly originalServerEmit: typeof Server.prototype.emit;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    requestTracker: RequestTrackerLike;
    bodyCapture: BodyCaptureLike;
    headerFilter: HeaderFilterLike;
    config: ResolvedConfig;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.requestTracker = deps.requestTracker;
    this.bodyCapture = deps.bodyCapture;
    this.headerFilter = deps.headerFilter;
    this.config = deps.config;
    this.tryBindStore();
    this.originalServerEmit = Server.prototype.emit;
    this.installEmitPatch();
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
        context.body = slot.requestBody;
        context.bodyTruncated = slot.requestBodyTruncated;
      };

      this.bodyCapture.captureInboundRequest(request, slot, seq, updatePayloadBytes);
      this.bodyCapture.captureOutboundResponse(response, slot, seq, (oldBytes, newBytes) => {
        this.buffer.updatePayloadBytes(oldBytes, newBytes);
      });

      let finalized = false;
      const finalize = (aborted: boolean): void => {
        if (finalized) {
          return;
        }

        finalized = true;
        slot.aborted = aborted;
        slot.statusCode = response.statusCode ?? slot.statusCode;
        slot.responseHeaders = this.headerFilter.filterHeaders(
          copyHeaders(response.getHeaders() as Record<string, unknown>)
        );
        slot.endTime = process.hrtime.bigint();
        slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
        slot.phase = 'done';
        context.body = slot.requestBody;
        context.bodyTruncated = slot.requestBodyTruncated;
        this.requestTracker.remove(context.requestId);
        this.requestContexts.delete(request);
      };

      response.on('finish', () => {
        finalize(false);
      });

      request.on('aborted', () => {
        finalize(true);
      });

      request.on('close', () => {
        if (!response.writableEnded) {
          finalize(true);
        }
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record inbound HTTP request: ${messageText}`);
    }
  }

  public shutdown(): void {
    Server.prototype.emit = this.originalServerEmit;
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

    Server.prototype.emit = (function (this: Server, eventName: string, ...args: unknown[]) {
      if (eventName !== 'request') {
        return previousEmit.apply(this, [eventName, ...args]);
      }

      const request = args[0] as IncomingMessage | undefined;

      if (request === undefined) {
        return previousEmit.apply(this, [eventName, ...args]);
      }

      const context = recorder.getOrCreateContext(request);

      return recorder.als.runWithContext(context, () =>
        previousEmit.apply(this, [eventName, ...args])
      );
    }) as typeof Server.prototype.emit;
  }

  private getOrCreateContext(request: IncomingMessage): RequestContext {
    const existing = this.requestContexts.get(request);

    if (existing !== undefined) {
      return existing;
    }

    const headers = this.headerFilter.filterHeaders(
      copyHeaders(request.headers as Record<string, unknown>)
    );
    const context = this.als.createRequestContext({
      method: request.method ?? 'UNKNOWN',
      url: request.url ?? '',
      headers
    });

    this.requestContexts.set(request, context);
    return context;
  }
}
