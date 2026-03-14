/**
 * @module 07-body-capture
 * @spec spec/07-body-capture.md
 * @dependencies types.ts, config.ts, io-event-buffer.ts (IOEventSlot, updatePayloadBytes)
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { IOEventSlot, RequestContext } from '../types';

const METADATA_OVERHEAD = 256;
const BODY_CAPTURE_STATE = Symbol('ecd.bodyCaptureState');
const INBOUND_REQUEST_CAPTURE = Symbol('ecd.inboundRequestCapture');
const OUTBOUND_RESPONSE_CAPTURE = Symbol('ecd.outboundResponseCapture');

interface BodyCaptureConfig {
  maxPayloadSize: number;
  captureBody: boolean;
  captureBodyDigest?: boolean;
  bodyCaptureContentTypes?: string[];
  scrubber?: {
    scrubBodyBuffer(
      buffer: Buffer,
      headers: Record<string, string> | null | undefined
    ): Buffer;
  };
}

interface AccumulatorState {
  chunks: Buffer[];
  totalBytesSeen: number;
  capturedBytes: number;
  truncated: boolean;
  finalized: boolean;
  contentTypeChecked: boolean;
  digest: ReturnType<typeof createHash> | null;
  digestHex: string | null;
  headers: Record<string, string> | null;
}

interface SlotCaptureState {
  request?: AccumulatorState;
  response?: AccumulatorState;
}

interface InboundRequestCaptureHandler {
  capture: BodyCapture;
  slot: IOEventSlot;
  seq: number;
  state: AccumulatorState;
  attached: boolean;
  originalOn: IncomingMessage['on'];
  onBytesChanged: (oldBytes: number, newBytes: number) => void;
}

interface OutboundResponseCaptureHandler {
  capture: BodyCapture;
  slot: IOEventSlot;
  seq: number;
  state: AccumulatorState;
  originalWrite: ServerResponse['write'];
  originalEnd: ServerResponse['end'];
  onBytesChanged: (oldBytes: number, newBytes: number) => void;
}

function estimateBytes(slot: IOEventSlot): number {
  return (
    METADATA_OVERHEAD +
    (slot.requestBody?.length ?? 0) +
    (slot.responseBody?.length ?? 0)
  );
}

function toBufferView(chunk: unknown, encoding?: BufferEncoding): Buffer | null {
  if (chunk === null || chunk === undefined || chunk === false) {
    return null;
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  if (typeof chunk === 'string') {
    return Buffer.from(chunk, encoding);
  }

  return Buffer.from(String(chunk));
}

export class BodyCapture {
  private readonly maxPayloadSize: number;

  private readonly captureBody: boolean;

  private readonly captureDigest: boolean;

  private readonly bodyCaptureContentTypes: string[];

  private readonly statePool: AccumulatorState[] = [];

  private readonly scrubber?: BodyCaptureConfig['scrubber'];

  public constructor(config: BodyCaptureConfig) {
    this.maxPayloadSize = config.maxPayloadSize;
    this.captureBody = config.captureBody;
    this.captureDigest = config.captureBodyDigest ?? false;
    this.bodyCaptureContentTypes = (config.bodyCaptureContentTypes ?? []).map((value) =>
      value.trim().toLowerCase()
    );
    this.scrubber = config.scrubber;
  }

  private static handleInboundRequestOn(
    this: IncomingMessage,
    eventName: string,
    listener: (...args: unknown[]) => void
  ): IncomingMessage {
    const request = this as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return this;
    }

    if (eventName === 'data' && !handler.attached) {
      handler.attached = true;
      Reflect.apply(handler.originalOn, this, ['data', BodyCapture.handleInboundRequestData]);
      Reflect.apply(handler.originalOn, this, ['end', BodyCapture.handleInboundRequestEnd]);
    }

    return Reflect.apply(handler.originalOn, this, [eventName, listener]) as IncomingMessage;
  }

  private static handleInboundRequestData(this: IncomingMessage, chunk: unknown): void {
    const request = this as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return;
    }

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'requestBody',
      'requestBodyTruncated',
      'requestBodyOriginalSize',
      chunk
    );

    if (handler.state.truncated) {
      request.removeListener('data', BodyCapture.handleInboundRequestData);
    }
  }

  private static handleInboundRequestEnd(this: IncomingMessage): void {
    const request = this as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };
    const handler = request[INBOUND_REQUEST_CAPTURE];

    if (handler === undefined) {
      return;
    }

    request.on = handler.originalOn;
    delete request[INBOUND_REQUEST_CAPTURE];
    handler.capture.finalizeCapture({
      slot: handler.slot,
      seq: handler.seq,
      bodyKey: 'requestBody',
      digestKey: 'requestBodyDigest',
      truncatedKey: 'requestBodyTruncated',
      originalSizeKey: 'requestBodyOriginalSize',
      state: handler.state,
      headers: handler.slot.requestHeaders,
      onBytesChanged: handler.onBytesChanged
    });
  }

  private static handleOutboundResponseFinish(this: ServerResponse): void {
    const response = this as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };
    const handler = response[OUTBOUND_RESPONSE_CAPTURE];

    if (handler === undefined) {
      return;
    }

    handler.capture.restoreOutboundResponse(response, handler);
    delete response[OUTBOUND_RESPONSE_CAPTURE];
  }

  private static handleOutboundResponseWrite(
    this: ServerResponse,
    chunk: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    const response = this as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };
    const handler = response[OUTBOUND_RESPONSE_CAPTURE];

    if (handler === undefined) {
      return true;
    }

    if (handler.capture.skipOutboundResponseCapture(response, handler)) {
      return handler.originalWrite.call(
        response,
        chunk as never,
        encoding as never,
        callback as never
      );
    }

    const normalizedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'responseBody',
      'responseBodyTruncated',
      'responseBodyOriginalSize',
      chunk,
      normalizedEncoding
    );

    return handler.originalWrite.call(
      response,
      chunk as never,
      encoding as never,
      callback as never
    );
  }

  private static handleOutboundResponseEnd(
    this: ServerResponse,
    chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): ServerResponse {
    const response = this as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };
    const handler = response[OUTBOUND_RESPONSE_CAPTURE];

    if (handler === undefined) {
      return this;
    }

    if (handler.capture.skipOutboundResponseCapture(response, handler)) {
      return handler.originalEnd.call(
        response,
        chunk as never,
        encoding as never,
        callback as never
      );
    }

    const normalizedEncoding =
      typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

    handler.capture.captureChunk(
      handler.state,
      handler.slot,
      'responseBody',
      'responseBodyTruncated',
      'responseBodyOriginalSize',
      chunk,
      normalizedEncoding
    );

    handler.capture.finalizeCapture({
      slot: handler.slot,
      seq: handler.seq,
      bodyKey: 'responseBody',
      digestKey: 'responseBodyDigest',
      truncatedKey: 'responseBodyTruncated',
      originalSizeKey: 'responseBodyOriginalSize',
      state: handler.state,
      headers: handler.slot.responseHeaders,
      onBytesChanged: handler.onBytesChanged
    });

    return handler.originalEnd.call(
      response,
      chunk as never,
      encoding as never,
      callback as never
    );
  }

  public captureInboundRequest(
    req: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isEnabled()) {
      return;
    }

    const state = this.createState(slot.requestHeaders);
    this.setState(slot, 'request', state);
    const request = req as IncomingMessage & {
      [INBOUND_REQUEST_CAPTURE]?: InboundRequestCaptureHandler;
    };

    request[INBOUND_REQUEST_CAPTURE] = {
      capture: this,
      slot,
      seq,
      state,
      attached: false,
      originalOn: req.on,
      onBytesChanged
    };
    req.on = BodyCapture.handleInboundRequestOn as IncomingMessage['on'];
  }

  public captureOutboundResponse(
    res: ServerResponse,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isEnabled()) {
      return;
    }

    const state = this.createState(null);
    this.setState(slot, 'response', state);
    const response = res as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    };

    response[OUTBOUND_RESPONSE_CAPTURE] = {
      capture: this,
      slot,
      seq,
      state,
      originalWrite: res.write,
      originalEnd: res.end,
      onBytesChanged
    };

    res.on('finish', BodyCapture.handleOutboundResponseFinish);
    res.write = BodyCapture.handleOutboundResponseWrite as ServerResponse['write'];
    res.end = BodyCapture.handleOutboundResponseEnd as ServerResponse['end'];
  }

  public captureClientResponse(
    res: IncomingMessage,
    slot: IOEventSlot,
    seq: number,
    onBytesChanged: (oldBytes: number, newBytes: number) => void
  ): void {
    if (!this.isEnabled()) {
      return;
    }

    const state = this.createState(null);
    this.setState(slot, 'response', state);

    const dataListener = (chunk: unknown) => {
      this.captureChunk(
        state,
        slot,
        'responseBody',
        'responseBodyTruncated',
        'responseBodyOriginalSize',
        chunk
      );

      if (state.truncated) {
        res.removeListener('data', dataListener);
      }
    };

    res.on('data', dataListener);
    res.on('end', () => {
      this.finalizeCapture({
        slot,
        seq,
        bodyKey: 'responseBody',
        digestKey: 'responseBodyDigest',
        truncatedKey: 'responseBodyTruncated',
        originalSizeKey: 'responseBodyOriginalSize',
        state,
        headers: slot.responseHeaders,
        onBytesChanged
      });
    });
  }

  public materializeSlotBodies(slot: IOEventSlot): void {
    if (!this.isEnabled()) {
      return;
    }

    this.materializeBody(slot, 'requestBody', 'requestBodyDigest', slot.requestHeaders);
    this.materializeBody(slot, 'responseBody', 'responseBodyDigest', slot.responseHeaders);
  }

  public materializeContextBody(context: RequestContext): void {
    const slot = [...context.ioEvents]
      .reverse()
      .find((candidate) => candidate.type === 'http-server' && candidate.direction === 'inbound');

    if (slot === undefined) {
      return;
    }

    this.materializeSlotBodies(slot);
    context.body = slot.requestBody;
    context.bodyTruncated = slot.requestBodyTruncated;
  }

  private isEnabled(): boolean {
    return this.captureBody && this.maxPayloadSize > 0;
  }

  private createState(headers: Record<string, string> | null): AccumulatorState {
    const state = this.statePool.pop();

    if (state !== undefined) {
      state.chunks.length = 0;
      state.totalBytesSeen = 0;
      state.capturedBytes = 0;
      state.truncated = false;
      state.finalized = false;
      state.contentTypeChecked = false;
      state.digest = this.captureDigest ? createHash('sha256') : null;
      state.digestHex = null;
      state.headers = headers;
      return state;
    }

    return {
      chunks: [],
      totalBytesSeen: 0,
      capturedBytes: 0,
      truncated: false,
      finalized: false,
      contentTypeChecked: false,
      digest: this.captureDigest ? createHash('sha256') : null,
      digestHex: null,
      headers
    };
  }

  private shouldCaptureContentType(contentType: string): boolean {
    if (this.bodyCaptureContentTypes.length === 0) {
      return true;
    }

    const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';

    if (normalized === '') {
      return true;
    }

    return this.bodyCaptureContentTypes.some((candidate) => normalized.startsWith(candidate));
  }

  private captureChunk(
    state: AccumulatorState,
    slot: IOEventSlot,
    bodyKey: 'requestBody' | 'responseBody',
    truncatedKey: 'requestBodyTruncated' | 'responseBodyTruncated',
    originalSizeKey: 'requestBodyOriginalSize' | 'responseBodyOriginalSize',
    chunk: unknown,
    encoding?: BufferEncoding
  ): void {
    if (state.truncated) {
      return;
    }

    const buffer = toBufferView(chunk, encoding);

    if (buffer === null) {
      return;
    }

    state.totalBytesSeen += buffer.length;
    const remaining = this.maxPayloadSize - state.capturedBytes;

    if (remaining <= 0) {
      state.truncated = true;
      slot[truncatedKey] = true;
      slot[originalSizeKey] = state.totalBytesSeen;
      return;
    }

    const captured =
      buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);

    state.chunks.push(captured);
    state.capturedBytes += captured.length;
    if (state.digest !== null) {
      state.digest.update(captured);
    }

    if (buffer.length <= remaining) {
      return;
    }

    state.truncated = true;
    slot[truncatedKey] = true;
    slot[originalSizeKey] = state.totalBytesSeen;
  }

  private restoreOutboundResponse(
    res: ServerResponse,
    handler: OutboundResponseCaptureHandler
  ): void {
    res.write = handler.originalWrite;
    res.end = handler.originalEnd;
  }

  private skipOutboundResponseCapture(
    res: ServerResponse,
    handler: OutboundResponseCaptureHandler
  ): boolean {
    if (handler.state.contentTypeChecked) {
      return false;
    }

    handler.state.contentTypeChecked = true;
    const contentType = res.getHeader?.('content-type');

    if (
      contentType === undefined ||
      contentType === null ||
      this.shouldCaptureContentType(String(contentType))
    ) {
      return false;
    }

    this.restoreOutboundResponse(res, handler);
    delete (res as ServerResponse & {
      [OUTBOUND_RESPONSE_CAPTURE]?: OutboundResponseCaptureHandler;
    })[OUTBOUND_RESPONSE_CAPTURE];
    delete this.getState(handler.slot).response;
    this.releaseState(handler.state);
    return true;
  }

  private releaseState(state: AccumulatorState): void {
    state.chunks.length = 0;
    state.totalBytesSeen = 0;
    state.capturedBytes = 0;
    state.truncated = false;
    state.finalized = false;
    state.contentTypeChecked = false;
    state.digest = null;
    state.digestHex = null;
    state.headers = null;
    this.statePool.push(state);
  }

  private finalizeCapture(input: {
    slot: IOEventSlot;
    seq: number;
    bodyKey: 'requestBody' | 'responseBody';
    digestKey: 'requestBodyDigest' | 'responseBodyDigest';
    truncatedKey: 'requestBodyTruncated' | 'responseBodyTruncated';
    originalSizeKey: 'requestBodyOriginalSize' | 'responseBodyOriginalSize';
    state: AccumulatorState;
    headers: Record<string, string> | null;
    onBytesChanged: (oldBytes: number, newBytes: number) => void;
  }): void {
    const {
      slot,
      seq,
      bodyKey,
      digestKey,
      state,
      headers,
      onBytesChanged
    } = input;

    if (slot.seq !== seq) {
      delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
      this.releaseState(state);
      return;
    }

    const oldBytes = slot.estimatedBytes;
    state.finalized = true;
    state.headers = headers;
    if (state.digest !== null && state.digestHex === null && state.capturedBytes > 0) {
      state.digestHex = state.digest.digest('hex');
    }

    slot[bodyKey] = null;
    slot[digestKey] = state.digestHex;
    slot.estimatedBytes = oldBytes + state.capturedBytes;

    onBytesChanged(oldBytes, slot.estimatedBytes);

    if (state.capturedBytes === 0 && !state.truncated) {
      delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
      this.releaseState(state);
    }
  }

  private getState(slot: IOEventSlot): SlotCaptureState {
    const trackedSlot = slot as IOEventSlot & { [BODY_CAPTURE_STATE]?: SlotCaptureState };
    trackedSlot[BODY_CAPTURE_STATE] ??= {};
    return trackedSlot[BODY_CAPTURE_STATE] as SlotCaptureState;
  }

  private setState(
    slot: IOEventSlot,
    bodyType: 'request' | 'response',
    state: AccumulatorState
  ): void {
    this.getState(slot)[bodyType] = state;
  }

  private materializeBody(
    slot: IOEventSlot,
    bodyKey: 'requestBody' | 'responseBody',
    digestKey: 'requestBodyDigest' | 'responseBodyDigest',
    headers: Record<string, string> | null
  ): void {
    if (slot[bodyKey] !== null) {
      return;
    }

    const state = this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
    if (state === undefined) {
      return;
    }

    if (state.digest !== null && state.digestHex === null && state.capturedBytes > 0) {
      state.digestHex = state.finalized
        ? state.digest.digest('hex')
        : state.digest.copy().digest('hex');
    }

    const body = Buffer.concat(state.chunks, state.capturedBytes);
    const scrubbed = this.scrubber?.scrubBodyBuffer(body, headers ?? state.headers) ?? body;

    slot[bodyKey] = scrubbed;
    slot[digestKey] = state.digestHex;
    delete this.getState(slot)[bodyKey === 'requestBody' ? 'request' : 'response'];
    this.releaseState(state);
  }
}
