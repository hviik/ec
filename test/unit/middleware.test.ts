import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ALSManager } from '../../src/context/als-manager';
import { expressMiddleware } from '../../src/middleware/express';
import { fastifyPlugin } from '../../src/middleware/fastify';
import { koaMiddleware } from '../../src/middleware/koa';
import { hapiPlugin } from '../../src/middleware/hapi';
import { wrapHandler } from '../../src/middleware/raw-http';

function createSdk(options?: { active?: boolean; throwOnCreate?: boolean }) {
  const als = new ALSManager();
  let addedContext: { requestId: string } | undefined;

  return {
    sdk: {
      isActive: () => options?.active ?? true,
      als: {
        createRequestContext: vi.fn((input: {
          method: string;
          url: string;
          headers: Record<string, string>;
        }) => {
          if (options?.throwOnCreate) {
            throw new Error('sdk failure');
          }

          return als.createRequestContext(input);
        }),
        runWithContext: als.runWithContext.bind(als),
        getContext: als.getContext.bind(als),
        getRequestId: als.getRequestId.bind(als)
      },
      requestTracker: {
        add: vi.fn((ctx: { requestId: string }) => {
          addedContext = ctx;
        }),
        remove: vi.fn()
      }
    },
    als,
    getAddedContext: () => addedContext
  };
}

describe('middleware adapters', () => {
  it('express propagates ALS context through async handlers and cleans up on finish', async () => {
    const { sdk, als, getAddedContext } = createSdk();
    const middleware = expressMiddleware(sdk);
    const req = {
      method: 'GET',
      url: '/users',
      headers: {
        host: 'service.local',
        authorization: 'secret'
      }
    };
    const res = new EventEmitter() as EventEmitter & { finished?: boolean };
    let observedRequestId: string | undefined;

    await new Promise<void>((resolve) => {
      middleware(req, res, () => {
        setTimeout(() => {
          observedRequestId = als.getRequestId();
          resolve();
        }, 0);
      });
    });

    const captured = getAddedContext();

    req.method = 'POST';
    req.url = '/mutated';
    req.headers.host = 'changed.local';
    res.emit('finish');

    expect(observedRequestId).toBe(captured?.requestId);
    expect(captured).toMatchObject({
      method: 'GET',
      url: '/users',
      headers: {
        host: 'service.local',
        authorization: 'secret'
      }
    });
    expect((captured as Record<string, unknown>)?.req).toBeUndefined();
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.remove).toHaveBeenCalledWith(captured?.requestId);
  });

  it('express passes through when SDK is not active', () => {
    const { sdk } = createSdk({ active: false });
    const middleware = expressMiddleware(sdk);
    const next = vi.fn();

    middleware(
      { method: 'GET', url: '/', headers: {} },
      new EventEmitter() as never,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(sdk.requestTracker.add).not.toHaveBeenCalled();
  });

  it('fastify hook sets up ALS context', () => {
    const { sdk, als } = createSdk();
    let hook:
      | ((
          request: {
            raw: {
              method: string;
              url: string;
              headers: Record<string, unknown>;
            };
          },
          reply: {
            raw: { finished?: boolean; on(event: 'finish', listener: () => void): void };
          },
          done: () => void
        ) => void)
      | undefined;
    const fastify = {
      addHook: vi.fn((_name, handler) => {
        hook = handler;
      })
    };

    fastifyPlugin(sdk)(fastify as never, {}, () => undefined);

    let requestId: string | undefined;

    hook?.(
      {
        raw: {
          method: 'POST',
          url: '/items',
          headers: { host: 'service.local' }
        }
      },
      {
        raw: new EventEmitter() as EventEmitter & {
          finished?: boolean;
          on(event: 'finish', listener: () => void): void;
        }
      },
      () => {
        requestId = als.getRequestId();
      }
    );

    expect(requestId).toBeDefined();
  });

  it('koa propagates context through the async middleware chain', async () => {
    const { sdk, als } = createSdk();
    const middleware = koaMiddleware(sdk);
    const ctx = {
      request: {
        method: 'PUT',
        url: '/account',
        headers: { host: 'service.local' }
      },
      res: new EventEmitter() as EventEmitter & {
        finished?: boolean;
        on(event: 'finish', listener: () => void): void;
      }
    };
    let requestId: string | undefined;

    await middleware(ctx as never, async () => {
      await Promise.resolve();
      requestId = als.getRequestId();
    });

    expect(requestId).toBeDefined();
  });

  it('hapi plugin registers onRequest and enters ALS context', () => {
    const { sdk, als } = createSdk();
    let handler:
      | ((
          request: {
            method: string;
            url: { pathname: string };
            headers: Record<string, unknown>;
            raw: { res: EventEmitter & { finished?: boolean } };
          },
          h: { continue: symbol }
        ) => symbol)
      | undefined;
    const marker = Symbol('continue');
    const server = {
      ext: vi.fn((_name, extHandler) => {
        handler = extHandler;
      })
    };

    hapiPlugin.register(server as never, { sdk });

    const result = handler?.(
      {
        method: 'get',
        url: { pathname: '/hapi' },
        headers: { host: 'service.local' },
        raw: { res: new EventEmitter() as EventEmitter & { finished?: boolean } }
      },
      { continue: marker }
    );

    expect(result).toBe(marker);
    expect(als.getRequestId()).toBeUndefined();
    expect(sdk.requestTracker.add).toHaveBeenCalledTimes(1);
  });

  it('raw handler wrapper exposes ALS context inside the handler', () => {
    const { sdk, als } = createSdk();
    let requestId: string | undefined;
    const wrapped = wrapHandler(
      (_req, _res) => {
        requestId = als.getRequestId();
      },
      sdk
    );

    wrapped(
      { method: 'DELETE', url: '/raw', headers: { host: 'service.local' } },
      new EventEmitter() as never
    );

    expect(requestId).toBeDefined();
  });

  it('SDK exceptions do not break the request pipeline', async () => {
    const expressSdk = createSdk({ throwOnCreate: true }).sdk;
    const next = vi.fn();

    expressMiddleware(expressSdk)(
      { method: 'GET', url: '/', headers: {} },
      new EventEmitter() as never,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);

    const rawSdk = createSdk({ throwOnCreate: true }).sdk;
    const handler = vi.fn();

    wrapHandler(handler, rawSdk)(
      { method: 'GET', url: '/', headers: {} },
      new EventEmitter() as never
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
