/**
 * @module 03-io-event-buffer
 * @spec spec/03-io-event-buffer.md
 * @dependencies types.ts (IOEventSlot)
 */

import type { IOEventSlot } from '../types';

// Accounts for serialized JSON field names and structure, not the in-memory null slot size.
const METADATA_OVERHEAD = 256;

type PushableIOEvent = Omit<IOEventSlot, 'seq' | 'estimatedBytes'>;

interface IOEventBufferOptions {
  capacity: number;
  maxBytes: number;
}

interface IOEventBufferStats {
  slotCount: number;
  payloadBytes: number;
  overflowCount: number;
  capacity: number;
  maxBytes: number;
}

function estimateBytes(event: {
  requestBody: Buffer | null;
  responseBody: Buffer | null;
}): number {
  return (
    METADATA_OVERHEAD +
    (event.requestBody?.length ?? 0) +
    (event.responseBody?.length ?? 0)
  );
}

export class IOEventBuffer {
  private readonly slots: (IOEventSlot | null)[];

  private readonly capacity: number;

  private readonly maxBytes: number;

  private writeHead = 0;

  private readHead = 0;

  private slotCount = 0;

  private payloadBytes = 0;

  private overflowCount = 0;

  private nextSeq = 1;

  private readonly slotPool: IOEventSlot[] = [];

  public constructor(options: IOEventBufferOptions) {
    this.capacity = options.capacity;
    this.maxBytes = options.maxBytes;
    this.slots = new Array<IOEventSlot | null>(this.capacity).fill(null);
  }

  public push(event: PushableIOEvent): { slot: IOEventSlot; seq: number } {
    const seq = this.nextSeq;
    const estimatedBytes = estimateBytes(event);
    const index = this.writeHead % this.capacity;
    const overwrittenSlot = this.slots[index];

    if (overwrittenSlot !== null) {
      this.evictIndex(index);
    }

    while (this.payloadBytes + estimatedBytes > this.maxBytes && this.slotCount > 0) {
      this.evictOldest();
    }

    const slot = this.claimSlot();
    this.assignSlot(slot, event, seq, estimatedBytes);

    this.slots[index] = slot;
    this.payloadBytes += estimatedBytes;
    this.slotCount += 1;
    this.writeHead += 1;
    this.nextSeq += 1;

    return { slot, seq };
  }

  public updatePayloadBytes(oldBytes: number, newBytes: number): void {
    this.payloadBytes += newBytes - oldBytes;
  }

  public filterByRequestId(requestId: string): IOEventSlot[] {
    return this.collectChronological().filter((slot) => slot.requestId === requestId);
  }

  public getRecent(n: number): IOEventSlot[] {
    if (n <= 0 || this.slotCount === 0) {
      return [];
    }

    const recent: IOEventSlot[] = [];

    for (let cursor = this.writeHead - 1; cursor >= this.readHead; cursor -= 1) {
      const slot = this.slots[cursor % this.capacity];

      if (slot !== null) {
        recent.push(slot);
      }

      if (recent.length >= n) {
        break;
      }
    }

    return recent.reverse();
  }

  public drain(): IOEventSlot[] {
    return this.collectChronological();
  }

  public clear(): void {
    for (let cursor = this.readHead; cursor < this.writeHead; cursor += 1) {
      const index = cursor % this.capacity;
      const slot = this.slots[index];

      if (slot !== null) {
        this.recycleSlot(slot);
        this.slots[index] = null;
      }
    }

    this.payloadBytes = 0;
    this.slotCount = 0;
    this.readHead = this.writeHead;
  }

  public getOverflowCount(): number {
    return this.overflowCount;
  }

  public getStats(): IOEventBufferStats {
    return {
      slotCount: this.slotCount,
      payloadBytes: this.payloadBytes,
      overflowCount: this.overflowCount,
      capacity: this.capacity,
      maxBytes: this.maxBytes
    };
  }

  private collectChronological(): IOEventSlot[] {
    const liveSlots: IOEventSlot[] = [];

    for (let cursor = this.readHead; cursor < this.writeHead; cursor += 1) {
      const slot = this.slots[cursor % this.capacity];

      if (slot !== null) {
        liveSlots.push(slot);
      }
    }

    return liveSlots;
  }

  private evictOldest(): void {
    const index = this.readHead % this.capacity;
    this.evictIndex(index);
  }

  private evictIndex(index: number): void {
    const slot = this.slots[index];
    if (slot === null) {
      return;
    }

    this.slots[index] = null;
    this.payloadBytes -= slot.estimatedBytes;
    this.slotCount -= 1;
    this.overflowCount += 1;
    this.recycleSlot(slot);

    if (this.slotCount === 0) {
      this.readHead = this.writeHead;
      return;
    }

    if (index === this.readHead % this.capacity) {
      this.readHead += 1;
    }
  }

  private claimSlot(): IOEventSlot {
    return this.slotPool.pop() ?? ({} as IOEventSlot);
  }

  private recycleSlot(slot: IOEventSlot): void {
    slot.requestBody = null;
    slot.responseBody = null;
    slot.requestBodyDigest = null;
    slot.responseBodyDigest = null;
    slot.requestHeaders = null;
    slot.responseHeaders = null;
    slot.error = null;
    slot.dbMeta = undefined;
    this.slotPool.push(slot);
  }

  private assignSlot(
    slot: IOEventSlot,
    event: PushableIOEvent,
    seq: number,
    estimatedBytes: number
  ): void {
    slot.seq = seq;
    slot.phase = event.phase;
    slot.startTime = event.startTime;
    slot.endTime = event.endTime;
    slot.durationMs = event.durationMs;
    slot.type = event.type;
    slot.direction = event.direction;
    slot.requestId = event.requestId;
    slot.contextLost = event.contextLost;
    slot.target = event.target;
    slot.method = event.method;
    slot.url = event.url;
    slot.statusCode = event.statusCode;
    slot.fd = event.fd;
    slot.requestHeaders = event.requestHeaders;
    slot.responseHeaders = event.responseHeaders;
    slot.requestBody = event.requestBody;
    slot.responseBody = event.responseBody;
    slot.requestBodyDigest = event.requestBodyDigest ?? null;
    slot.responseBodyDigest = event.responseBodyDigest ?? null;
    slot.requestBodyTruncated = event.requestBodyTruncated;
    slot.responseBodyTruncated = event.responseBodyTruncated;
    slot.requestBodyOriginalSize = event.requestBodyOriginalSize;
    slot.responseBodyOriginalSize = event.responseBodyOriginalSize;
    slot.error = event.error;
    slot.aborted = event.aborted;
    slot.dbMeta = event.dbMeta;
    slot.estimatedBytes = estimatedBytes;
  }
}
