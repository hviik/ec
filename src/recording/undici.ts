/**
 * @module 08-io-recording
 * @spec spec/08-io-recording.md
 * @dependencies types.ts, io-event-buffer.ts, als-manager.ts, request-tracker.ts, body-capture.ts, header-filter.ts
 */

import type { IOEventSlot, RequestContext } from '../types';
import { isSdkInternalRequest } from './internal';
import { normalizeHeaderValue, toDurationMs } from './utils';

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
}

interface HeaderFilterLike {
  filterHeaders(headers: Record<string, string>): Record<string, string>;
}

function normalizeHeaders(input: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string') {
        const value = normalizeHeaderValue(entry[1]);

        if (value !== null) {
          normalized[entry[0]] = value;
        }
      }
    }

    return normalized;
  }

  if (input instanceof Map) {
    for (const [key, value] of input.entries()) {
      if (typeof key === 'string') {
        const normalizedValue = normalizeHeaderValue(value);

        if (normalizedValue !== null) {
          normalized[key] = normalizedValue;
        }
      }
    }

    return normalized;
  }

  if (typeof input === 'object' && input !== null) {
    for (const [key, value] of Object.entries(input)) {
      const normalizedValue = normalizeHeaderValue(value);

      if (normalizedValue !== null) {
        normalized[key] = normalizedValue;
      }
    }
  }

  return normalized;
}

function getRequestRecord(request: unknown): Record<string, unknown> | null {
  return typeof request === 'object' && request !== null
    ? (request as Record<string, unknown>)
    : null;
}

function extractTarget(request: Record<string, unknown>): {
  method: string | null;
  target: string;
  url: string | null;
  requestHeaders: Record<string, string>;
} {
  const method = typeof request.method === 'string' ? request.method : null;
  const origin = typeof request.origin === 'string' ? request.origin : '';
  const path = typeof request.path === 'string' ? request.path : '';
  const url =
    typeof request.url === 'string'
      ? request.url
      : origin !== '' || path !== ''
        ? `${origin}${path}`
        : null;

  return {
    method,
    target: origin !== '' ? origin : url ?? 'undici',
    url,
    requestHeaders: normalizeHeaders(request.headers)
  };
}

export class UndiciRecorder {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManagerLike;

  private readonly headerFilter: HeaderFilterLike;

  private readonly slots = new WeakMap<object, IOEventSlot>();

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManagerLike;
    headerFilter: HeaderFilterLike;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.headerFilter = deps.headerFilter;
  }

  public handleRequestCreate(message: { request: unknown }): void {
    try {
      const request = getRequestRecord(message.request);

      if (request === null) {
        return;
      }

      if (isSdkInternalRequest(request)) {
        return;
      }

      const context = this.als.getContext();
      const extracted = extractTarget(request);
      const { slot } = this.buffer.push({
        phase: 'active',
        startTime: process.hrtime.bigint(),
        endTime: null,
        durationMs: null,
        type: 'undici',
        direction: 'outbound',
        requestId: context?.requestId ?? null,
        contextLost: context === undefined,
        target: extracted.target,
        method: extracted.method,
        url: extracted.url,
        statusCode: null,
        fd: null,
        requestHeaders: this.headerFilter.filterHeaders(extracted.requestHeaders),
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
      this.slots.set(message.request as object, slot);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record undici request creation: ${messageText}`);
    }
  }

  public handleRequestHeaders(message: { request: unknown; response: unknown }): void {
    try {
      const slot = this.getSlot(message.request);

      if (slot === undefined) {
        return;
      }

      const response = getRequestRecord(message.response);

      if (response === null) {
        return;
      }

      slot.statusCode =
        typeof response.statusCode === 'number' ? response.statusCode : null;
      slot.responseHeaders = this.headerFilter.filterHeaders(
        normalizeHeaders(response.headers)
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record undici response headers: ${messageText}`);
    }
  }

  public handleRequestTrailers(message: { request: unknown; trailers: unknown }): void {
    try {
      const slot = this.getSlot(message.request);

      if (slot === undefined) {
        return;
      }

      slot.endTime = process.hrtime.bigint();
      slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
      slot.phase = 'done';
      this.slots.delete(message.request as object);
      void message.trailers;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record undici request trailers: ${messageText}`);
    }
  }

  public handleRequestError(message: { request: unknown; error: Error }): void {
    try {
      const slot = this.getSlot(message.request);

      if (slot === undefined) {
        return;
      }

      slot.error = {
        type: message.error.name,
        message: message.error.message
      };
      slot.endTime = process.hrtime.bigint();
      slot.durationMs = toDurationMs(slot.startTime, slot.endTime);
      slot.phase = 'done';
      this.slots.delete(message.request as object);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Failed to record undici request error: ${messageText}`);
    }
  }

  public shutdown(): void {
    return;
  }

  private getSlot(request: unknown): IOEventSlot | undefined {
    return typeof request === 'object' && request !== null
      ? this.slots.get(request)
      : undefined;
  }
}
