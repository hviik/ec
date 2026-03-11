/**
 * @module 09-database-patches
 * @spec spec/09-database-patches.md
 * @dependencies types.ts, io-event-buffer.ts, als-manager.ts
 */

import type { AsyncLocalStorage } from 'node:async_hooks';

import { install as installIoredisPatch } from './ioredis';
import { install as installMongodbPatch } from './mongodb';
import { install as installMysql2Patch } from './mysql2';
import { install as installPgPatch } from './pg';
import type { IOEventSlot, RequestContext, ResolvedConfig } from '../../types';

const ORIGINAL_METHODS = Symbol('ecd.originalMethods');

type WrappedTarget = Record<string | symbol, unknown> & {
  [ORIGINAL_METHODS]?: Map<string, Function>;
};

type Wrapper = (original: Function) => Function;

interface IOEventBufferLike {
  push(event: Omit<IOEventSlot, 'seq' | 'estimatedBytes'>): {
    slot: IOEventSlot;
    seq: number;
  };
}

interface ALSManagerLike {
  getContext(): RequestContext | undefined;
  getStore?: () => AsyncLocalStorage<RequestContext>;
}

export interface PatchInstallDeps {
  buffer: IOEventBufferLike;
  als: ALSManagerLike;
  config: ResolvedConfig;
}

function getOriginalMethodStore(target: WrappedTarget): Map<string, Function> {
  if (target[ORIGINAL_METHODS] === undefined) {
    Object.defineProperty(target, ORIGINAL_METHODS, {
      value: new Map<string, Function>(),
      configurable: true,
      enumerable: false,
      writable: false
    });
  }

  return target[ORIGINAL_METHODS] as Map<string, Function>;
}

export function wrapMethod(target: object, methodName: string, wrapper: Wrapper): void {
  const wrappedTarget = target as WrappedTarget;
  const current = wrappedTarget[methodName];

  if (typeof current !== 'function') {
    return;
  }

  unwrapMethod(target, methodName);

  const store = getOriginalMethodStore(wrappedTarget);
  const original = wrappedTarget[methodName];

  if (typeof original !== 'function') {
    return;
  }

  store.set(methodName, original);
  wrappedTarget[methodName] = wrapper(original);
}

export function unwrapMethod(target: object, methodName: string): void {
  const wrappedTarget = target as WrappedTarget;
  const store = wrappedTarget[ORIGINAL_METHODS];

  if (store === undefined) {
    return;
  }

  const original = store.get(methodName);

  if (original === undefined) {
    return;
  }

  wrappedTarget[methodName] = original;
  store.delete(methodName);
}

export class PatchManager {
  private readonly deps: PatchInstallDeps;

  private uninstallers: Array<() => void> = [];

  public constructor(deps: PatchInstallDeps) {
    this.deps = deps;
  }

  public installAll(): void {
    this.unwrapAll();
    this.uninstallers = [
      installPgPatch(this.deps),
      installMysql2Patch(this.deps),
      installIoredisPatch(this.deps),
      installMongodbPatch(this.deps)
    ];
  }

  public unwrapAll(): void {
    while (this.uninstallers.length > 0) {
      this.uninstallers.pop()?.();
    }
  }
}
