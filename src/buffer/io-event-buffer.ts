/**
 * @module 03-io-event-buffer
 * @spec spec/03-io-event-buffer.md
 * @dependencies types.ts (IOEventSlot)
 */

import type { IOEventSlot } from '../types';

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

  private slotCount = 0;

  private payloadBytes = 0;

  private overflowCount = 0;

  private nextSeq = 1;

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
      this.payloadBytes -= overwrittenSlot.estimatedBytes;
      this.overflowCount += 1;
      this.slots[index] = null;
      this.slotCount -= 1;
    }

    while (this.payloadBytes + estimatedBytes > this.maxBytes && this.slotCount > 0) {
      const oldestIndex = this.findOldestLiveIndex();

      if (oldestIndex === null) {
        break;
      }

      const oldestSlot = this.slots[oldestIndex];

      if (oldestSlot === null) {
        break;
      }

      this.slots[oldestIndex] = null;
      this.payloadBytes -= oldestSlot.estimatedBytes;
      this.slotCount -= 1;
      this.overflowCount += 1;
    }

    const slot: IOEventSlot = {
      ...event,
      seq,
      estimatedBytes
    };

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
    const start = Math.max(this.writeHead - this.capacity, 0);

    for (let cursor = this.writeHead - 1; cursor >= start; cursor -= 1) {
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
    this.slots.fill(null);
    this.payloadBytes = 0;
    this.slotCount = 0;
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
    const start = Math.max(this.writeHead - this.capacity, 0);

    for (let cursor = start; cursor < this.writeHead; cursor += 1) {
      const slot = this.slots[cursor % this.capacity];

      if (slot !== null) {
        liveSlots.push(slot);
      }
    }

    return liveSlots;
  }

  private findOldestLiveIndex(): number | null {
    const start = Math.max(this.writeHead - this.capacity, 0);

    for (let cursor = start; cursor < this.writeHead; cursor += 1) {
      const index = cursor % this.capacity;

      if (this.slots[index] !== null) {
        return index;
      }
    }

    return null;
  }
}
