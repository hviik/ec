/**
 * @module 05-encryption-and-security
 * @spec spec/05-encryption-and-security.md
 * @dependencies types.ts, config.ts
 */

interface RateLimiterConfig {
  maxCaptures: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly maxCaptures: number;

  private readonly windowMs: number;

  private timestamps: number[] = [];

  private droppedCount = 0;

  public constructor(config: RateLimiterConfig) {
    this.maxCaptures = config.maxCaptures ?? 10;
    this.windowMs = config.windowMs ?? 60000;
  }

  public tryAcquire(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);

    if (this.timestamps.length < this.maxCaptures) {
      this.timestamps.push(now);
      return true;
    }

    this.droppedCount += 1;
    return false;
  }

  public getDroppedCount(): number {
    return this.droppedCount;
  }

  public reset(): void {
    this.timestamps = [];
    this.droppedCount = 0;
  }
}
