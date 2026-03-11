/**
 * @module 07-body-capture
 * @spec spec/07-body-capture.md
 * @dependencies types.ts, config.ts, io-event-buffer.ts (IOEventSlot, updatePayloadBytes)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { IOEventSlot } from '../types';

const METADATA_OVERHEAD = 256;

interface BodyCaptureConfig {
  maxPayloadSize: number;
  captureBody: boolean;
}

interface AccumulatorState {
  chunks: Buffer[];
  totalBytesSeen: number;
  capturedBytes: number;
  truncated: boolean;
}

function estimateBytes(slot: IOEventSlot): number {
  return (
    METADATA_OVERHEAD +
    (slot.requestBody?.length ?? 0) +
    (slot.responseBody?.length ?? 0)
  );
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer | null {
  if (chunk === null || chunk === undefined || chunk === false) {
    return null;
  }

  if (Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk);
  }

  if (typeof chunk === 'string') {
    return Buffer.from(chunk, encoding);
  }

  return Buffer.from(String(chunk));
}

export class BodyCapture {
  private readonly maxPayloadSize: number;

  private readonly captureBody: boolean;

  public constructor(config: BodyCaptureConfig) {
    this.maxPayloadSize = config.maxPayloadSize;
    this.captureBody = config.captureBody;
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

    const state = this.createState();
    const originalOn = req.on.bind(req);
    let attached = false;

    const dataListener = (chunk: unknown) => {
      this.captureChunk(state, slot, 'requestBody', 'requestBodyTruncated', 'requestBodyOriginalSize', chunk);

      if (state.truncated) {
        req.removeListener('data', dataListener);
      }
    };

    const endListener = () => {
      this.finalizeCapture({
        slot,
        seq,
        bodyKey: 'requestBody',
        truncatedKey: 'requestBodyTruncated',
        originalSizeKey: 'requestBodyOriginalSize',
        state,
        onBytesChanged
      });
    };

    req.on = ((eventName: string, listener: (...args: unknown[]) => void) => {
      if (eventName === 'data' && !attached) {
        attached = true;
        originalOn('data', dataListener);
        originalOn('end', endListener);
      }

      return originalOn(eventName, listener);
    }) as IncomingMessage['on'];
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

    const state = this.createState();
    const originalWrite = res.write;
    const originalEnd = res.end;

    const restore = () => {
      res.write = originalWrite as ServerResponse['write'];
      res.end = originalEnd as ServerResponse['end'];
    };

    res.on('finish', restore);

    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      const normalizedEncoding =
        typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

      this.captureChunk(
        state,
        slot,
        'responseBody',
        'responseBodyTruncated',
        'responseBodyOriginalSize',
        chunk,
        normalizedEncoding
      );

      return originalWrite.call(
        res,
        chunk as never,
        encoding as never,
        callback as never
      );
    }) as ServerResponse['write'];

    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      const normalizedEncoding =
        typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;

      this.captureChunk(
        state,
        slot,
        'responseBody',
        'responseBodyTruncated',
        'responseBodyOriginalSize',
        chunk,
        normalizedEncoding
      );

      this.finalizeCapture({
        slot,
        seq,
        bodyKey: 'responseBody',
        truncatedKey: 'responseBodyTruncated',
        originalSizeKey: 'responseBodyOriginalSize',
        state,
        onBytesChanged
      });

      return originalEnd.call(
        res,
        chunk as never,
        encoding as never,
        callback as never
      );
    }) as ServerResponse['end'];
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

    const state = this.createState();

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
        truncatedKey: 'responseBodyTruncated',
        originalSizeKey: 'responseBodyOriginalSize',
        state,
        onBytesChanged
      });
    });
  }

  private isEnabled(): boolean {
    return this.captureBody && this.maxPayloadSize > 0;
  }

  private createState(): AccumulatorState {
    return {
      chunks: [],
      totalBytesSeen: 0,
      capturedBytes: 0,
      truncated: false
    };
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

    const buffer = toBuffer(chunk, encoding);

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

    if (buffer.length <= remaining) {
      state.chunks.push(buffer);
      state.capturedBytes += buffer.length;
      return;
    }

    state.chunks.push(buffer.subarray(0, remaining));
    state.capturedBytes += remaining;
    state.truncated = true;
    slot[truncatedKey] = true;
    slot[originalSizeKey] = state.totalBytesSeen;
    slot[bodyKey] = null;
  }

  private finalizeCapture(input: {
    slot: IOEventSlot;
    seq: number;
    bodyKey: 'requestBody' | 'responseBody';
    truncatedKey: 'requestBodyTruncated' | 'responseBodyTruncated';
    originalSizeKey: 'requestBodyOriginalSize' | 'responseBodyOriginalSize';
    state: AccumulatorState;
    onBytesChanged: (oldBytes: number, newBytes: number) => void;
  }): void {
    const {
      slot,
      seq,
      bodyKey,
      state,
      onBytesChanged
    } = input;

    if (slot.seq !== seq) {
      state.chunks = [];
      return;
    }

    const oldBytes = slot.estimatedBytes;
    const body = Buffer.concat(state.chunks, state.capturedBytes);

    slot[bodyKey] = body;
    slot.estimatedBytes = estimateBytes(slot);

    onBytesChanged(oldBytes, slot.estimatedBytes);
    state.chunks = [];
  }
}
