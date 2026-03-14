import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { IncomingMessage, ClientRequest, ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config';
import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import { ALSManager } from '../../src/context/als-manager';
import { RequestTracker } from '../../src/context/request-tracker';
import { HeaderFilter } from '../../src/pii/header-filter';
import { Scrubber } from '../../src/pii/scrubber';
import { BodyCapture } from '../../src/recording/body-capture';
import { HttpServerRecorder } from '../../src/recording/http-server';
import { ECD_INTERNAL, HttpClientRecorder } from '../../src/recording/http-client';
import { UndiciRecorder } from '../../src/recording/undici';
import { NetDnsRecorder, runAsInternal } from '../../src/recording/net-dns';
import type { RequestContext } from '../../src/types';

const require = createRequire(import.meta.url);
const dnsModule = require('node:dns') as typeof import('node:dns');

class MockIncomingRequest extends EventEmitter {
  public method = 'GET';

  public url = '/resource';

  public headers: Record<string, string> = {
    host: 'service.local',
    authorization: 'secret-token'
  };

  public socket = {
    _handle: {
      fd: 11
    }
  };
}

class MockIncomingResponse extends EventEmitter {
  public statusCode = 200;

  public headers: Record<string, string> = {
    'content-type': 'application/json',
    'set-cookie': 'secret'
  };
}

class MockServerResponse extends EventEmitter {
  public statusCode = 200;

  public writableEnded = false;

  public writableFinished = false;

  private readonly headers: Record<string, string> = {};

  public setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  public getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  public write(
    _chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): boolean {
    const done =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined;

    done?.();
    return true;
  }

  public end(
    _chunk?: unknown,
    encoding?: unknown,
    callback?: unknown
  ): this {
    const done =
      typeof encoding === 'function'
        ? (encoding as () => void)
        : typeof callback === 'function'
          ? (callback as () => void)
          : undefined;

    done?.();
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }
}

class MockClientRequest extends EventEmitter {
  public method = 'POST';

  public protocol = 'https:';

  public host = 'api.example.com';

  public port = 443;

  public path = '/v1/items';

  public socket = {
    _handle: {
      fd: 22
    }
  };

  private readonly headers: Record<string, string> = {
    host: 'api.example.com',
    authorization: 'top-secret',
    'user-agent': 'test-client'
  };

  public getHeaders(): Record<string, string> {
    return { ...this.headers };
  }

  public getHeader(name: string): string | undefined {
    return this.headers[name];
  }
}

function createConfig() {
  return resolveConfig({
    maxPayloadSize: 1024,
    maxConcurrentRequests: 10,
    allowUnencrypted: true
  });
}

function createRequestContext(als: ALSManager, requestId = 'req-ctx'): RequestContext {
  const context = als.createRequestContext({
    method: 'GET',
    url: '/origin',
    headers: { host: 'localhost' }
  });

  context.requestId = requestId;
  return context;
}

describe('Module 08 recorders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records inbound HTTP requests, propagates ALS context, and attaches body capture', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const headerFilter = new HeaderFilter(config);
    const bodyCapture = new BodyCapture(config);
    const scrubber = new Scrubber(config);
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture,
      headerFilter,
      scrubber,
      config
    });
    const server = new Server();
    const originalEmit = Server.prototype.emit;
    const req = new MockIncomingRequest();
    const res = new MockServerResponse();
    let observedRequestId: string | undefined;

    res.statusCode = 201;
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'hidden');
    recorder.install();
    const fallbackEmitPatchInstalled = Server.prototype.emit !== originalEmit;

    server.on('request', () => {
      observedRequestId = als.getRequestId();
    });

    try {
      if (fallbackEmitPatchInstalled) {
        server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse);
      } else {
        const context = (
          recorder as unknown as {
            getOrCreateContext(request: IncomingMessage): RequestContext;
          }
        ).getOrCreateContext(req as unknown as IncomingMessage);

        als.runWithContext(context, () => {
          server.emit('request', req as unknown as IncomingMessage, res as unknown as ServerResponse);
        });
      }

      recorder.handleRequestStart({
        request: req as unknown as IncomingMessage,
        response: res as unknown as ServerResponse,
        socket: req.socket as never,
        server
      });

      req.headers.host = 'mutated.local';
      req.on('data', () => undefined);
      req.emit('data', Buffer.from('hello'));
      req.emit('end');
      res.write('wor');
      res.end('ld');
      const [slot] = buffer.drain();
      if (slot) {
        bodyCapture.materializeSlotBodies(slot);
      }

      expect(observedRequestId).toBe(slot?.requestId ?? undefined);
      expect(slot).toMatchObject({
        type: 'http-server',
        direction: 'inbound',
        method: 'GET',
        url: '/resource',
        statusCode: 201,
        requestHeaders: { host: 'service.local' },
        responseHeaders: { 'content-type': 'application/json' },
        aborted: false,
        contextLost: false
      });
      expect(slot?.requestBody?.toString()).toBe('hello');
      expect(slot?.responseBody?.toString()).toBe('world');
      expect(tracker.getCount()).toBe(0);
      expect((slot as Record<string, unknown> | undefined)?.request).toBeUndefined();
      expect((slot as Record<string, unknown> | undefined)?.response).toBeUndefined();
    } finally {
      recorder.shutdown();
      tracker.shutdown();
      server.close();
    }
  });

  it('marks aborted inbound requests', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60000 });
    const recorder = new HttpServerRecorder({
      buffer,
      als,
      requestTracker: tracker,
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config),
      scrubber: new Scrubber(config),
      config
    });
    const req = new MockIncomingRequest();
    const res = new MockServerResponse();

    try {
      recorder.handleRequestStart({
        request: req as unknown as IncomingMessage,
        response: res as unknown as ServerResponse,
        socket: req.socket as never,
        server: new Server()
      });

      req.emit('aborted');
      res.emit('close');

      const [slot] = buffer.drain();

      expect(slot?.aborted).toBe(true);
      expect(slot?.phase).toBe('done');
    } finally {
      recorder.shutdown();
      tracker.shutdown();
    }
  });

  it('records outbound HTTP client requests and response metadata', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const context = createRequestContext(als);
    const bodyCapture = new BodyCapture(config);
    const recorder = new HttpClientRecorder({
      buffer,
      als,
      bodyCapture,
      headerFilter: new HeaderFilter(config)
    });
    const request = new MockClientRequest();
    const response = new MockIncomingResponse();

    als.runWithContext(context, () => {
      recorder.handleRequestStart({ request: request as unknown as ClientRequest });
    });

    request.emit('response', response as unknown as IncomingMessage);
    response.emit('data', Buffer.from('ok'));
    response.emit('end');
    const [slot] = buffer.drain();
    if (slot) {
      bodyCapture.materializeSlotBodies(slot);
    }

    expect(slot).toMatchObject({
      type: 'http-client',
      target: 'https://api.example.com:443',
      url: 'https://api.example.com:443/v1/items',
      statusCode: 200,
      requestHeaders: {
        host: 'api.example.com',
        'user-agent': 'test-client'
      },
      responseHeaders: {
        'content-type': 'application/json'
      },
      contextLost: false,
      requestId: 'req-ctx'
    });
    expect(slot?.responseBody?.toString()).toBe('ok');
    expect(context.ioEvents[0]).toBe(slot);
    recorder.shutdown();
  });

  it('ignores SDK-internal outbound HTTP client requests', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new HttpClientRecorder({
      buffer,
      als: new ALSManager(),
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config)
    });
    const request = new MockClientRequest() as MockClientRequest & {
      [ECD_INTERNAL]?: boolean;
    };

    request[ECD_INTERNAL] = true;
    recorder.handleRequestStart({ request: request as unknown as ClientRequest });

    expect(buffer.drain()).toEqual([]);
    recorder.shutdown();
  });

  it('records outbound HTTP client errors with contextLost when ALS is unavailable', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new HttpClientRecorder({
      buffer,
      als: new ALSManager(),
      bodyCapture: new BodyCapture(config),
      headerFilter: new HeaderFilter(config)
    });
    const request = new MockClientRequest();

    recorder.handleRequestStart({ request: request as unknown as ClientRequest });
    request.emit('error', new Error('connect failed'));

    const [slot] = buffer.drain();

    expect(slot).toMatchObject({
      contextLost: true,
      requestId: null,
      error: {
        type: 'Error',
        message: 'connect failed'
      }
    });
    recorder.shutdown();
  });

  it('records undici request create, headers, and trailers without stale correlation', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const als = new ALSManager();
    const recorder = new UndiciRecorder({
      buffer,
      als,
      headerFilter: new HeaderFilter(config)
    });
    const firstRequest = {
      method: 'POST',
      origin: 'https://undici.example.com',
      path: '/items',
      headers: {
        authorization: 'secret',
        'user-agent': 'undici-test'
      }
    };
    const secondRequest = {
      method: 'GET',
      origin: 'https://undici.example.com',
      path: '/health',
      headers: {
        'user-agent': 'undici-test'
      }
    };
    const context = createRequestContext(als, 'req-undici');

    als.runWithContext(context, () => {
      recorder.handleRequestCreate({ request: firstRequest });
    });
    recorder.handleRequestHeaders({
      request: firstRequest,
      response: {
        statusCode: 202,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'secret'
        }
      }
    });
    recorder.handleRequestTrailers({ request: firstRequest, trailers: {} });
    recorder.handleRequestCreate({ request: secondRequest });
    recorder.handleRequestError({
      request: secondRequest,
      error: new Error('upstream failed')
    });

    const slots = buffer.drain();

    expect(slots[0]).toMatchObject({
      type: 'undici',
      target: 'https://undici.example.com',
      url: 'https://undici.example.com/items',
      statusCode: 202,
      requestHeaders: { 'user-agent': 'undici-test' },
      responseHeaders: { 'content-type': 'application/json' },
      requestId: 'req-undici',
      contextLost: false
    });
    expect(slots[1]).toMatchObject({
      type: 'undici',
      url: 'https://undici.example.com/health',
      error: {
        type: 'Error',
        message: 'upstream failed'
      }
    });
    recorder.shutdown();
  });

  it('ignores SDK-internal undici requests', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new UndiciRecorder({
      buffer,
      als: new ALSManager(),
      headerFilter: new HeaderFilter(config)
    });
    const request = {
      method: 'POST',
      origin: 'https://undici.example.com',
      path: '/items',
      headers: {},
      [ECD_INTERNAL]: true
    };

    recorder.handleRequestCreate({ request });

    expect(buffer.drain()).toEqual([]);
    recorder.shutdown();
  });

  it('records DNS lookups through the internal patch and marks contextLost when ALS is unavailable', async () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const originalLookup = dnsModule.lookup;
    
    dnsModule.lookup = ((
      hostname: string,
      callback: (error: null, address: string, family: number) => void
    ) => {
      callback(null, '127.0.0.1', 4);
      return {} as never;
    }) as typeof dnsModule.lookup;

    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      await new Promise<void>((resolve, reject) => {
        (dnsModule.lookup as unknown as (
        hostname: string,
          callback: (error: Error | null, address: string, family: number) => void
        ) => void)('example.com', (error) => {
          if (error !== null) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      const [slot] = buffer.drain();

      expect(slot).toMatchObject({
        type: 'dns',
        target: 'example.com',
        contextLost: true,
        requestId: null
      });
      expect(slot?.durationMs).not.toBeNull();
    } finally {
      dnsModule.lookup = originalLookup;
      recorder.shutdown();
    }
  });

  it('skips DNS lookups executed through runAsInternal', async () => {
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const originalLookup = dnsModule.lookup;

    dnsModule.lookup = ((
      hostname: string,
      callback: (error: null, address: string, family: number) => void
    ) => {
      callback(null, '127.0.0.1', 4);
      return {} as never;
    }) as typeof dnsModule.lookup;

    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      await new Promise<void>((resolve, reject) => {
        runAsInternal(() => {
          (dnsModule.lookup as unknown as (
            hostname: string,
            callback: (error: Error | null, address: string, family: number) => void
          ) => void)('example.com', (error) => {
            if (error !== null) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      });

      expect(buffer.drain()).toEqual([]);
    } finally {
      dnsModule.lookup = originalLookup;
      recorder.shutdown();
    }
  });

  it('records TCP connect events via the net handler with contextLost when ALS is unavailable', () => {
    const config = createConfig();
    const buffer = new IOEventBuffer({ capacity: 10, maxBytes: 100000 });
    const recorder = new NetDnsRecorder({
      buffer,
      als: new ALSManager()
    });

    try {
      recorder.handleNetConnect({
        target: '127.0.0.1:5432',
        startTime: 1n,
        endTime: 2n,
        socket: { _handle: { fd: 33 } } as never
      });

      const [slot] = buffer.drain();

      expect(slot).toMatchObject({
        type: 'tcp',
        target: '127.0.0.1:5432',
        fd: 33,
        contextLost: true,
        requestId: null
      });
    } finally {
      recorder.shutdown();
    }
  });
});
