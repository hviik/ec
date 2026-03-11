/**
 * @module 06-request-context
 * @spec spec/06-request-context.md
 * @dependencies types.ts, config.ts
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { RequestContext } from '../types';

export class ALSManager {
  private readonly store: AsyncLocalStorage<RequestContext>;

  public constructor() {
    this.store = new AsyncLocalStorage<RequestContext>();
  }

  public createRequestContext(req: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): RequestContext {
    return {
      requestId: randomUUID(),
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
