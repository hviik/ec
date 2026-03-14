/**
 * @module 06-request-context
 * @spec spec/06-request-context.md
 * @dependencies types.ts, config.ts
 */

import type { RequestContext, RequestSummary } from '../types';

interface RequestTrackerConfig {
  maxConcurrent: number;
  ttlMs: number;
}

export class RequestTracker {
  private readonly maxConcurrent: number;

  private readonly ttlMs: number;

  private readonly contexts = new Map<string, RequestContext>();

  private capacityWarningActive = false;

  private readonly sweepTimer: NodeJS.Timeout;

  public constructor(config: RequestTrackerConfig) {
    this.maxConcurrent = config.maxConcurrent;
    this.ttlMs = config.ttlMs ?? 300000;
    this.sweepTimer = setInterval(() => {
      this.sweepExpired();
    }, 60000);
    this.sweepTimer.unref();
  }

  public add(ctx: RequestContext): void {
    if (this.contexts.size >= this.maxConcurrent) {
      if (!this.capacityWarningActive) {
        this.capacityWarningActive = true;
        console.debug('[ECD] RequestTracker at capacity; dropping tracked request');
      }
      return;
    }

    this.contexts.set(ctx.requestId, ctx);
  }

  public remove(requestId: string): void {
    this.contexts.delete(requestId);
    this.resetCapacityWarningIfAvailable();
  }

  public getAll(): RequestContext[] {
    return [...this.contexts.values()];
  }

  public getSummaries(): RequestSummary[] {
    return this.getAll().map((ctx) => ({
      requestId: ctx.requestId,
      method: ctx.method,
      url: ctx.url,
      startTime: ctx.startTime.toString()
    }));
  }

  public getCount(): number {
    return this.contexts.size;
  }

  public shutdown(): void {
    clearInterval(this.sweepTimer);
    this.contexts.clear();
    this.capacityWarningActive = false;
  }

  private sweepExpired(): void {
    const now = process.hrtime.bigint();
    const ttlNs = BigInt(this.ttlMs) * 1000000n;

    for (const [requestId, context] of this.contexts.entries()) {
      if (now - context.startTime > ttlNs) {
        this.contexts.delete(requestId);
      }
    }

    this.resetCapacityWarningIfAvailable();
  }

  private resetCapacityWarningIfAvailable(): void {
    if (this.contexts.size < this.maxConcurrent) {
      this.capacityWarningActive = false;
    }
  }
}
