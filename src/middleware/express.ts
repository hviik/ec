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

export function expressMiddleware(sdk?: SDKInstanceLike) {
  return (
    req: { method: string; url: string; headers: Record<string, unknown> },
    res: { finished?: boolean; on(event: 'finish', listener: () => void): void },
    next: () => void
  ): void => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive() || res.finished === true) {
      next();
      return;
    }

    try {
      const ctx = instance.als.createRequestContext({
        method: req.method,
        url: req.url,
        headers: extractHeaders(req.headers)
      });

      instance.requestTracker.add(ctx);
      res.on('finish', () => {
        instance.requestTracker.remove(ctx.requestId);
      });
      instance.als.runWithContext(ctx, () => {
        next();
      });
    } catch {
      next();
    }
  };
}
