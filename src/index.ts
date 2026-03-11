/**
 * @module 16-sdk-composition
 * @spec spec/16-sdk-composition.md
 * @dependencies ALL modules (01-15)
 */

import type { SDKConfig } from './types';
import { SDKInstance, createSDK } from './sdk';

let instance: SDKInstance | null = null;

export function init(config?: Partial<SDKConfig>): SDKInstance {
  if (instance !== null) {
    throw new Error('SDK already initialized. Call shutdown() first.');
  }

  instance = createSDK(config ?? {});
  instance.activate();

  return instance;
}

export function captureError(error: Error): void {
  instance?.captureError(error);
}

export function trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
  name: string,
  container: T
): T {
  if (instance === null) {
    throw new Error('SDK is not initialized');
  }

  return instance.trackState(name, container);
}

export function withContext<T>(fn: () => T): T {
  if (instance === null) {
    return fn();
  }

  return instance.withContext(fn);
}

export async function shutdown(): Promise<void> {
  if (instance === null) {
    return;
  }

  await instance.shutdown();
  instance = null;
}

export { createSDK };

export function getModuleInstance(): SDKInstance | null {
  return instance;
}
