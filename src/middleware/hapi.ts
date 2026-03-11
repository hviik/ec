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

export const hapiPlugin = {
  name: 'ecd',
  register(
    server: {
      ext(
        name: 'onRequest',
        handler: (
          request: {
            method: string;
            url: { pathname: string };
            headers: Record<string, unknown>;
            raw: { res: { finished?: boolean; on(event: 'finish', listener: () => void): void } };
          },
          h: { continue: symbol }
        ) => symbol
      ): void;
    },
    options: { sdk?: SDKInstanceLike }
  ): void {
    server.ext('onRequest', (request, h) => {
      const instance = options.sdk ?? getModuleInstance();

      if (
        instance === null ||
        !instance.isActive() ||
        request.raw.res.finished === true
      ) {
        return h.continue;
      }

      try {
        const ctx = instance.als.createRequestContext({
          method: request.method.toUpperCase(),
          url: request.url.pathname,
          headers: extractHeaders(request.headers)
        });

        instance.requestTracker.add(ctx);
        request.raw.res.on('finish', () => {
          instance.requestTracker.remove(ctx.requestId);
        });
        return instance.als.runWithContext(ctx, () => h.continue);
      } catch {
        return h.continue;
      }
    });
  }
};
