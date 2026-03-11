/**
 * @module 15-middleware
 * @spec spec/15-middleware.md
 * @dependencies types.ts, als-manager.ts, request-tracker.ts
 */

interface SDKInstanceLike {
  isActive(): boolean;
  als: {
    createRequestContext(input: {
      method: string;
      url: string;
      headers: Record<string, string>;
    }): { requestId: string };
    runWithContext<T>(ctx: { requestId: string }, fn: () => T): T;
  };
  requestTracker: {
    add(ctx: { requestId: string }): void;
    remove(requestId: string): void;
  };
}

function getModuleInstance(): SDKInstanceLike | null {
  try {
    const moduleRef = require('../index') as {
      getModuleInstance?: () => SDKInstanceLike | null;
    };

    return moduleRef.getModuleInstance?.() ?? null;
  } catch {
    return null;
  }
}

function extractHeaders(headers: Record<string, unknown>): Record<string, string> {
  const copied: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      copied[key] = value;
    }
  }

  return copied;
}

export function koaMiddleware(sdk?: SDKInstanceLike) {
  return async (
    ctx: {
      request: { method: string; url: string; headers: Record<string, unknown> };
      res: { finished?: boolean; on(event: 'finish', listener: () => void): void };
    },
    next: () => Promise<unknown>
  ): Promise<unknown> => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive() || ctx.res.finished === true) {
      return next();
    }

    try {
      const requestContext = instance.als.createRequestContext({
        method: ctx.request.method,
        url: ctx.request.url,
        headers: extractHeaders(ctx.request.headers)
      });

      instance.requestTracker.add(requestContext);
      ctx.res.on('finish', () => {
        instance.requestTracker.remove(requestContext.requestId);
      });

      return await instance.als.runWithContext(requestContext, () => next());
    } catch {
      return next();
    }
  };
}
