import type { ClientRequest } from 'node:http';

export const ECD_INTERNAL = Symbol('ecd.internal');

export const SDK_INTERNAL_REQUESTS = new WeakSet<object>();

let internalCallDepth = 0;

export function runAsInternal<T>(fn: () => T): T {
  internalCallDepth += 1;

  try {
    return fn();
  } finally {
    internalCallDepth -= 1;
  }
}

export function isInternalCallActive(): boolean {
  return internalCallDepth > 0;
}

export function markRequestAsInternal<T extends ClientRequest>(request: T): T {
  SDK_INTERNAL_REQUESTS.add(request);
  (request as T & { [ECD_INTERNAL]?: true })[ECD_INTERNAL] = true;
  return request;
}

export function isSdkInternalRequest(request: unknown): boolean {
  if (isInternalCallActive()) {
    return true;
  }

  if (typeof request !== 'object' || request === null) {
    return false;
  }

  return (
    SDK_INTERNAL_REQUESTS.has(request) ||
    (request as { [ECD_INTERNAL]?: unknown })[ECD_INTERNAL] === true
  );
}
