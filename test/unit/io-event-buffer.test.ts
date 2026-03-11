import { describe, expect, it } from 'vitest';

import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import type { IOEventSlot } from '../../src/types';

type PushableIOEvent = Omit<IOEventSlot, 'seq' | 'estimatedBytes'>;

function createEvent(overrides: Partial<PushableIOEvent> = {}): PushableIOEvent {
  return {
    phase: 'active',
    startTime: 1n,
    endTime: null,
    durationMs: null,
    type: 'http-server',
    direction: 'inbound',
    requestId: 'req-default',
    contextLost: false,
    target: 'service',
    method: 'GET',
    url: '/resource',
    statusCode: null,
    fd: null,
    requestHeaders: { host: 'localhost' },
    responseHeaders: null,
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false,
    ...overrides
  };
}

function applyBackfill(
  buffer: IOEventBuffer,
  slot: IOEventSlot,
  expectedSeq: number,
  requestBody: Buffer
): boolean {
  if (slot.seq !== expectedSeq) {
    return false;
  }

  const oldBytes = slot.estimatedBytes;

  slot.requestBody = requestBody;
  slot.phase = 'done';
  slot.requestBodyOriginalSize = requestBody.length;
  slot.estimatedBytes = 256 + requestBody.length + (slot.responseBody?.length ?? 0);
  buffer.updatePayloadBytes(oldBytes, slot.estimatedBytes);

  return true;
}

describe('IOEventBuffer', () => {
  it('pushes and reads back a single event with computed metadata', () => {
    const buffer = new IOEventBuffer({ capacity: 3, maxBytes: 4096 });
    const { slot, seq } = buffer.push(
      createEvent({
        requestId: 'req-1',
        requestBody: Buffer.from('abc')
      })
    );

    expect(seq).toBe(1);
    expect(slot.seq).toBe(1);
    expect(slot.estimatedBytes).toBe(259);
    expect(buffer.drain()).toEqual([slot]);
    expect(buffer.getStats()).toEqual({
      slotCount: 1,
      payloadBytes: 259,
      overflowCount: 0,
      capacity: 3,
      maxBytes: 4096
    });
  });

  it('overwrites the oldest event when capacity is exceeded', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1', url: '/1' }));
    buffer.push(createEvent({ requestId: 'req-2', url: '/2' }));
    buffer.push(createEvent({ requestId: 'req-3', url: '/3' }));

    expect(buffer.drain().map((slot) => slot.requestId)).toEqual(['req-2', 'req-3']);
    expect(buffer.getOverflowCount()).toBe(1);
  });

  it('maintains chronological order after wrap-around', () => {
    const buffer = new IOEventBuffer({ capacity: 3, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));
    buffer.push(createEvent({ requestId: 'req-3' }));
    buffer.push(createEvent({ requestId: 'req-4' }));
    buffer.push(createEvent({ requestId: 'req-5' }));

    expect(buffer.drain().map((slot) => slot.requestId)).toEqual([
      'req-3',
      'req-4',
      'req-5'
    ]);
  });

  it('evicts oldest slots to satisfy the byte budget', () => {
    const buffer = new IOEventBuffer({ capacity: 5, maxBytes: 700 });

    buffer.push(
      createEvent({ requestId: 'req-1', requestBody: Buffer.alloc(300, 1) })
    );
    buffer.push(
      createEvent({ requestId: 'req-2', requestBody: Buffer.alloc(300, 2) })
    );

    expect(buffer.drain().map((slot) => slot.requestId)).toEqual(['req-2']);
    expect(buffer.getStats()).toEqual({
      slotCount: 1,
      payloadBytes: 556,
      overflowCount: 1,
      capacity: 5,
      maxBytes: 700
    });
  });

  it('keeps byte accounting accurate across pushes and overwrites', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1', requestBody: Buffer.alloc(10) }));
    buffer.push(createEvent({ requestId: 'req-2', responseBody: Buffer.alloc(20) }));
    buffer.push(createEvent({ requestId: 'req-3', requestBody: Buffer.alloc(5) }));

    const liveSlots = buffer.drain();
    const summedBytes = liveSlots.reduce((total, slot) => total + slot.estimatedBytes, 0);

    expect(buffer.getStats().payloadBytes).toBe(summedBytes);
    expect(liveSlots.map((slot) => slot.requestId)).toEqual(['req-2', 'req-3']);
  });

  it('filters by request id across interleaved requests', () => {
    const buffer = new IOEventBuffer({ capacity: 6, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-a', url: '/1' }));
    buffer.push(createEvent({ requestId: 'req-b', url: '/2' }));
    buffer.push(createEvent({ requestId: 'req-a', url: '/3' }));
    buffer.push(createEvent({ requestId: 'req-c', url: '/4' }));

    expect(buffer.filterByRequestId('req-a').map((slot) => slot.url)).toEqual([
      '/1',
      '/3'
    ]);
  });

  it('supports live body backfill and payload byte updates', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });
    const { slot, seq } = buffer.push(createEvent({ requestId: 'req-1' }));

    const applied = applyBackfill(buffer, slot, seq, Buffer.from('hello'));

    expect(applied).toBe(true);
    expect(slot.phase).toBe('done');
    expect(slot.requestBody?.toString()).toBe('hello');
    expect(slot.estimatedBytes).toBe(261);
    expect(buffer.getStats().payloadBytes).toBe(261);
  });

  it('silently discards recycled-slot backfill when the seq mismatches', () => {
    const buffer = new IOEventBuffer({ capacity: 1, maxBytes: 4096 });

    const first = buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));

    const currentSlot = buffer.drain()[0];
    const applied = applyBackfill(
      buffer,
      currentSlot,
      first.seq,
      Buffer.from('late-body')
    );

    expect(currentSlot.seq).not.toBe(first.seq);
    expect(applied).toBe(false);
    expect(currentSlot.requestBody).toBeNull();
    expect(buffer.getStats().payloadBytes).toBe(256);
  });

  it('clears all live slots and resets byte totals without resetting overflow count', () => {
    const buffer = new IOEventBuffer({ capacity: 2, maxBytes: 4096 });

    buffer.push(createEvent({ requestBody: Buffer.alloc(5) }));
    buffer.push(createEvent({ requestBody: Buffer.alloc(5) }));
    buffer.push(createEvent({ requestBody: Buffer.alloc(5) }));

    expect(buffer.getOverflowCount()).toBe(1);

    buffer.clear();

    expect(buffer.drain()).toEqual([]);
    expect(buffer.getStats()).toEqual({
      slotCount: 0,
      payloadBytes: 0,
      overflowCount: 1,
      capacity: 2,
      maxBytes: 4096
    });
  });

  it('returns all live slots when getRecent exceeds the slot count', () => {
    const buffer = new IOEventBuffer({ capacity: 5, maxBytes: 4096 });

    buffer.push(createEvent({ requestId: 'req-1' }));
    buffer.push(createEvent({ requestId: 'req-2' }));

    expect(buffer.getRecent(10).map((slot) => slot.requestId)).toEqual([
      'req-1',
      'req-2'
    ]);
  });

  it('stays consistent under a rapid push loop', () => {
    const buffer = new IOEventBuffer({ capacity: 100, maxBytes: 1000000 });

    for (let index = 0; index < 10000; index += 1) {
      buffer.push(createEvent({ requestId: `req-${index}` }));
    }

    const liveSlots = buffer.drain();
    const stats = buffer.getStats();
    const summedBytes = liveSlots.reduce((total, slot) => total + slot.estimatedBytes, 0);

    expect(liveSlots).toHaveLength(100);
    expect(liveSlots[0]?.seq).toBe(9901);
    expect(liveSlots[99]?.seq).toBe(10000);
    expect(stats.slotCount).toBe(100);
    expect(stats.overflowCount).toBe(9900);
    expect(stats.payloadBytes).toBe(summedBytes);
  });
});
