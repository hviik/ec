/**
 * @module 15-middleware
 * @spec spec/15-middleware.md
 * @dependencies types.ts, als-manager.ts, request-tracker.ts
 */

export interface SDKInstanceLike {
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

export function getModuleInstance(): SDKInstanceLike | null {
  try {
    const moduleRef = require('../index') as {
      getModuleInstance?: () => SDKInstanceLike | null;
    };

    return moduleRef.getModuleInstance?.() ?? null;
  } catch {
    return null;
  }
}

export function extractHeaders(
  headers: Record<string, unknown>
): Record<string, string> {
  const copied: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      copied[key] = value;
    }
  }

  return copied;
}
