/**
 * @module 15-middleware
 * @spec spec/15-middleware.md
 * @dependencies types.ts, als-manager.ts, request-tracker.ts
 */

import {
  extractHeaders,
  getModuleInstance,
  type SDKInstanceLike
} from './common';

export function wrapHandler<
  T extends (
    req: { method?: string; url?: string; headers: Record<string, unknown> },
    res: { finished?: boolean; on(event: 'finish', listener: () => void): void }
  ) => void
>(handler: T, sdk?: SDKInstanceLike): T {
  return ((req, res) => {
    const instance = sdk ?? getModuleInstance();

    if (instance === null || !instance.isActive() || res.finished === true) {
      handler(req, res);
      return;
    }

    try {
      const ctx = instance.als.createRequestContext({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: extractHeaders(req.headers)
      });

      instance.requestTracker.add(ctx);
      res.on('finish', () => {
        instance.requestTracker.remove(ctx.requestId);
      });
      instance.als.runWithContext(ctx, () => {
        handler(req, res);
      });
    } catch {
      handler(req, res);
    }
  }) as T;
}
