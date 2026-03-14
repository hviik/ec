/**
 * @module 06-request-context
 * @spec spec/06-request-context.md
 * @dependencies types.ts, config.ts
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { RequestContext } from '../types';

export class ALSManager {
  private readonly store: AsyncLocalStorage<RequestContext>;

  private readonly contextPool: RequestContext[] = [];

  private readonly pendingRelease: RequestContext[] = [];

  private readonly flushPendingReleases = (): void => {
    this.releaseFlushScheduled = false;

    let context = this.pendingRelease.pop();
    while (context !== undefined) {
      context.method = '';
      context.url = '';
      context.headers = {};
      context.body = null;
      context.bodyTruncated = false;
      context.ioEvents.length = 0;
      context.stateReads.length = 0;
      this.contextPool.push(context);
      context = this.pendingRelease.pop();
    }
  };

  private requestCounter = 0;

  private releaseFlushScheduled = false;

  public constructor() {
    this.store = new AsyncLocalStorage<RequestContext>();
  }

  public createRequestContext(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): RequestContext {
    const context = this.contextPool.pop();

    if (context !== undefined) {
      context.requestId = `${process.pid}-${++this.requestCounter}`;
      context.startTime = process.hrtime.bigint();
      context.method = req.method;
      context.url = req.url;
      context.headers = { ...req.headers };
      context.body = null;
      context.bodyTruncated = false;
      context.ioEvents.length = 0;
      context.stateReads.length = 0;
      return context;
    }

    return {
      requestId: `${process.pid}-${++this.requestCounter}`,
      startTime: process.hrtime.bigint(),
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: null,
      bodyTruncated: false,
      ioEvents: [],
      stateReads: []
    };
  }

  public releaseRequestContext(context: RequestContext): void {
    this.pendingRelease.push(context);
    if (this.releaseFlushScheduled) {
      return;
    }

    this.releaseFlushScheduled = true;
    queueMicrotask(this.flushPendingReleases);
  }

  public runWithContext<T>(ctx: RequestContext, fn: () => T): T {
    return this.store.run(ctx, fn);
  }

  public getContext(): RequestContext | undefined {
    return this.store.getStore();
  }

  public getRequestId(): string | undefined {
    return this.getContext()?.requestId;
  }

  public getStore(): AsyncLocalStorage<RequestContext> {
    return this.store;
  }
}
