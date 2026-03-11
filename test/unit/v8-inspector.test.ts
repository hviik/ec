import Module = require('node:module');

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config';
import { InspectorManager } from '../../src/capture/inspector-manager';

const originalRequire = Module.prototype.require;

interface MockSession {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createTimerStubs() {
  const timers: Array<{ id: NodeJS.Timeout; fn: () => void; unref: ReturnType<typeof vi.fn> }> =
    [];
  const setIntervalSpy = vi
    .spyOn(globalThis, 'setInterval')
    .mockImplementation(((fn: TimerHandler) => {
      const unref = vi.fn();
      const timer = { unref } as unknown as NodeJS.Timeout;

      timers.push({ id: timer, fn: fn as () => void, unref });
      return timer;
    }) as typeof setInterval);
  const clearIntervalSpy = vi
    .spyOn(globalThis, 'clearInterval')
    .mockImplementation(() => undefined as never);

  return { timers, setIntervalSpy, clearIntervalSpy };
}

function createInspectorMock(options?: {
  url?: string;
  connectThrows?: boolean;
  postHandlers?: Record<
    string,
    (params: Record<string, unknown> | undefined) => unknown
  >;
}) {
  const pausedHandlers: Array<(event: { params: unknown }) => void> = [];
  const session: MockSession = {
    connect: vi.fn(() => {
      if (options?.connectThrows) {
        throw new Error('connect failed');
      }
    }),
    disconnect: vi.fn(),
    post: vi.fn((method: string, paramsOrCallback?: unknown, callback?: unknown) => {
      const params =
        typeof paramsOrCallback === 'function'
          ? undefined
          : (paramsOrCallback as Record<string, unknown> | undefined);
      const cb =
        typeof paramsOrCallback === 'function'
          ? (paramsOrCallback as (error?: Error | null, result?: unknown) => void)
          : (callback as (error?: Error | null, result?: unknown) => void);
      const result = options?.postHandlers?.[method]?.(params);

      cb?.(null, result);
    }),
    on: vi.fn((event: string, handler: (event: { params: unknown }) => void) => {
      if (event === 'Debugger.paused') {
        pausedHandlers.push(handler);
      }
    })
  };
  class SessionConstructor {
    public constructor() {
      return session as unknown as SessionConstructor;
    }
  }
  const inspectorModule = {
    url: vi.fn(() => options?.url),
    Session: SessionConstructor
  };

  return {
    inspectorModule,
    session,
    emitPaused(params: unknown) {
      for (const handler of pausedHandlers) {
        handler({ params });
      }
    }
  };
}

function withInspectorMock<T>(
  inspectorModule: unknown,
  run: () => Promise<T> | T
): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:inspector') {
      return inspectorModule;
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

describe('InspectorManager', () => {
  afterEach(() => {
    Module.prototype.require = originalRequire;
    vi.restoreAllMocks();
  });

  it('is unavailable when captureLocalVariables is false', () => {
    const manager = new InspectorManager(resolveConfig({ captureLocalVariables: false }));

    expect(manager.isAvailable()).toBe(false);
    expect(manager.getLocals(new Error('boom'))).toBeNull();
  });

  it('enables the debugger and pause-on-exceptions when inspector is available', () => {
    const timers = createTimerStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({}));

      expect(manager.isAvailable()).toBe(true);
      expect(inspector.session.connect).toHaveBeenCalledTimes(1);
      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.enable',
        expect.any(Function)
      );
      expect(inspector.session.post).toHaveBeenCalledWith(
        'Debugger.setPauseOnExceptions',
        { state: 'all' },
        expect.any(Function)
      );
      expect(timers.timers).toHaveLength(2);
      expect(timers.timers[0]?.unref).toHaveBeenCalledTimes(1);
      expect(timers.timers[1]?.unref).toHaveBeenCalledTimes(1);
      manager.shutdown();
    });
  });

  it('resumes immediately for non-exception pauses', () => {
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({}));

      inspector.emitPaused({
        reason: 'other',
        callFrames: []
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Debugger.resume')
      ).toHaveLength(1);
      manager.shutdown();
    });
  });

  it('resumes without collecting when all frames are library code', () => {
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({}));

      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'boom' },
        callFrames: [
          {
            functionName: 'lib',
            location: { lineNumber: 0, columnNumber: 0 },
            url: '/app/node_modules/lib/index.js',
            scopeChain: []
          }
        ]
      });

      expect(manager.getLocals(new Error('boom'))).toBeNull();
      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('collects app-frame locals and caches them one-shot', () => {
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [
            { name: 'userId', value: { type: 'number', value: 42 } },
            { name: 'password', value: { type: 'string', value: 'secret' } },
            {
              name: 'items',
              value: { type: 'object', subtype: 'array', description: 'Array(2)' }
            }
          ]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({}));

      inspector.emitPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'boom' },
        callFrames: [
          {
            functionName: 'handler',
            location: { lineNumber: 9, columnNumber: 4 },
            url: '/app/src/handler.js',
            scopeChain: [
              {
                type: 'local',
                object: { type: 'object', objectId: 'scope-1' }
              }
            ]
          }
        ]
      });

      const first = manager.getLocals(new Error('boom'));
      const second = manager.getLocals(new Error('boom'));

      expect(first).toEqual([
        {
          functionName: 'handler',
          filePath: '/app/src/handler.js',
          lineNumber: 10,
          columnNumber: 5,
          locals: {
            userId: 42,
            password: '[REDACTED]',
            items: '[Array(Array(2))]'
          }
        }
      ]);
      expect(second).toBeNull();
      manager.shutdown();
    });
  });

  it('applies gate ordering for rate limiting and cache capacity', () => {
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => ({
          result: [{ name: 'value', value: { type: 'number', value: 1 } }]
        })
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(
        resolveConfig({
          maxLocalsCollectionsPerSecond: 1,
          maxCachedLocals: 1
        })
      ) as unknown as {
        collectionCountThisSecond: number;
        cache: Map<string, { frames: unknown[]; timestamp: number }>;
        _onPaused(params: unknown): void;
        shutdown(): void;
      };

      manager.collectionCountThisSecond = 1;
      manager._onPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'rate-limited' },
        callFrames: [
          {
            functionName: 'handler',
            location: { lineNumber: 0, columnNumber: 0 },
            url: '/app/src/handler.js',
            scopeChain: [{ type: 'local', object: { type: 'object', objectId: 'scope' } }]
          }
        ]
      });

      manager.collectionCountThisSecond = 0;
      manager.cache.set('existing', { frames: [], timestamp: Date.now() });
      manager._onPaused({
        reason: 'exception',
        data: { className: 'Error', description: 'cache-full' },
        callFrames: [
          {
            functionName: 'handler',
            location: { lineNumber: 0, columnNumber: 0 },
            url: '/app/src/handler.js',
            scopeChain: [{ type: 'local', object: { type: 'object', objectId: 'scope' } }]
          }
        ]
      });

      expect(
        inspector.session.post.mock.calls.filter((call) => call[0] === 'Runtime.getProperties')
      ).toHaveLength(0);
      manager.shutdown();
    });
  });

  it('serializes remote objects according to the shallow type table', () => {
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({})) as unknown as {
        _serializeRemoteObject(object: unknown): unknown;
        shutdown(): void;
      };

      expect(manager._serializeRemoteObject({ type: 'undefined' })).toBeUndefined();
      expect(manager._serializeRemoteObject({ type: 'string', value: 'text' })).toBe('text');
      expect(manager._serializeRemoteObject({ type: 'number', value: 5 })).toBe(5);
      expect(manager._serializeRemoteObject({ type: 'boolean', value: true })).toBe(true);
      expect(
        manager._serializeRemoteObject({ type: 'bigint', description: '10n' })
      ).toEqual({ _type: 'BigInt', value: '10n' });
      expect(
        manager._serializeRemoteObject({ type: 'symbol', description: 'Symbol(x)' })
      ).toEqual({ _type: 'Symbol', description: 'Symbol(x)' });
      expect(
        manager._serializeRemoteObject({ type: 'function', description: 'fn()' })
      ).toBe('[Function: fn()]');
      expect(
        manager._serializeRemoteObject({ type: 'object', subtype: 'null' })
      ).toBeNull();
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'regexp',
          description: '/x/'
        })
      ).toBe('/x/');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'date',
          description: '2026-01-01T00:00:00.000Z'
        })
      ).toBe('2026-01-01T00:00:00.000Z');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'error',
          description: 'Error: boom'
        })
      ).toBe('Error: boom');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'map',
          description: 'Map(1)'
        })
      ).toBe('[Map(Map(1))]');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          subtype: 'set',
          description: 'Set(1)'
        })
      ).toBe('[Set(Set(1))]');
      expect(
        manager._serializeRemoteObject({
          type: 'object',
          className: 'Object',
          description: 'Object'
        })
      ).toBe('[Object]');
      manager.shutdown();
    });
  });

  it('drops expired cache entries on sweep', () => {
    const timers = createTimerStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({})) as unknown as {
        cache: Map<string, { frames: unknown[]; timestamp: number }>;
        shutdown(): void;
      };

      manager.cache.set('Error: expired', {
        frames: [],
        timestamp: Date.now() - 31_000
      });

      timers.timers[1]?.fn();

      expect(manager.cache.size).toBe(0);
      manager.shutdown();
    });
  });

  it('always resumes even if collection throws inside the paused handler', () => {
    const inspector = createInspectorMock({
      postHandlers: {
        'Runtime.getProperties': () => {
          throw new Error('getProperties failed');
        }
      }
    });

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({})) as unknown as {
        _onPaused(params: unknown): void;
        shutdown(): void;
      };

      expect(() =>
        manager._onPaused({
          reason: 'exception',
          data: { className: 'Error', description: 'boom' },
          callFrames: [
            {
              functionName: 'handler',
              location: { lineNumber: 0, columnNumber: 0 },
              url: '/app/src/handler.js',
              scopeChain: [{ type: 'local', object: { type: 'object', objectId: 'scope' } }]
            }
          ]
        })
      ).not.toThrow();

      expect(
        inspector.session.post.mock.calls.some((call) => call[0] === 'Debugger.resume')
      ).toBe(true);
      manager.shutdown();
    });
  });

  it('shutdown disconnects the session, clears timers, empties cache, and marks unavailable', () => {
    const timers = createTimerStubs();
    const inspector = createInspectorMock();

    withInspectorMock(inspector.inspectorModule, () => {
      const manager = new InspectorManager(resolveConfig({})) as unknown as {
        cache: Map<string, { frames: unknown[]; timestamp: number }>;
        isAvailable(): boolean;
        shutdown(): void;
      };

      manager.cache.set('Error: boom', { frames: [], timestamp: Date.now() });
      manager.shutdown();

      expect(inspector.session.disconnect).toHaveBeenCalledTimes(1);
      expect(timers.clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(manager.cache.size).toBe(0);
      expect(manager.isAvailable()).toBe(false);
    });
  });
});
