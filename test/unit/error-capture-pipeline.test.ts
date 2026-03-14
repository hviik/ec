import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config';
import { Scrubber } from '../../src/pii/scrubber';
import { Encryption } from '../../src/security/encryption';
import { RateLimiter } from '../../src/security/rate-limiter';
import { ALSManager } from '../../src/context/als-manager';
import { RequestTracker } from '../../src/context/request-tracker';
import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import {
  buildPackageAssemblyResult,
  finalizePackageAssemblyResult,
  PackageBuilder
} from '../../src/capture/package-builder';
import { PackageAssemblyDispatcher } from '../../src/capture/package-assembly-dispatcher';
import { ProcessMetadata } from '../../src/capture/process-metadata';
import { ErrorCapturer } from '../../src/capture/error-capturer';
import type {
  ErrorPackageParts,
  IOEventSlot,
  PackageAssemblyWorkerData,
  PackageAssemblyWorkerRequest,
  PackageAssemblyWorkerResponse,
  RequestContext
} from '../../src/types';

const require = createRequire(import.meta.url);
const fsModule = require('node:fs') as typeof import('node:fs');
const noopBodyCapture = {
  materializeSlotBodies: () => undefined,
  materializeContextBody: () => undefined
};

function createSlot(overrides: Partial<IOEventSlot> = {}): IOEventSlot {
  return {
    seq: 1,
    phase: 'done',
    startTime: 1n,
    endTime: 2n,
    durationMs: 0.001,
    type: 'http-server',
    direction: 'inbound',
    requestId: 'req-1',
    contextLost: false,
    target: 'service.local',
    method: 'GET',
    url: '/resource',
    statusCode: 500,
    fd: 10,
    requestHeaders: { host: 'service.local' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: null,
    responseBody: null,
    requestBodyTruncated: false,
    responseBodyTruncated: false,
    requestBodyOriginalSize: null,
    responseBodyOriginalSize: null,
    error: null,
    aborted: false,
    estimatedBytes: 256,
    ...overrides
  };
}

function createContext(als: ALSManager, requestId: string): RequestContext {
  const context = als.createRequestContext({
    method: 'POST',
    url: '/login',
    headers: { host: 'service.local' }
  });

  context.requestId = requestId;
  return context;
}

function createTimeoutStubs() {
  const timers: Array<{ id: NodeJS.Timeout; fn: () => void; unref: ReturnType<typeof vi.fn> }> =
    [];
  const setTimeoutSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: TimerHandler) => {
      const unref = vi.fn();
      const timer = { unref } as unknown as NodeJS.Timeout;

      timers.push({ id: timer, fn: fn as () => void, unref });
      return timer;
    }) as typeof setTimeout);
  const clearTimeoutSpy = vi
    .spyOn(globalThis, 'clearTimeout')
    .mockImplementation(() => undefined as never);

  return { timers, setTimeoutSpy, clearTimeoutSpy };
}

function createPackageParts(
  context: RequestContext | undefined,
  overrides: Partial<ErrorPackageParts> = {}
): ErrorPackageParts {
  return {
    error: {
      type: 'Error',
      message: 'boom',
      stack: 'Error: boom',
      properties: {}
    },
    localVariables: null,
    requestContext:
      context === undefined
        ? undefined
        : {
            requestId: context.requestId,
            startTime: context.startTime,
            method: context.method,
            url: context.url,
            headers: { ...context.headers },
            body: context.body,
            bodyTruncated: context.bodyTruncated
          },
    ioTimeline: [],
    stateReads: context?.stateReads ?? [],
    concurrentRequests: [],
    processMetadata: {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime: 1,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1
      },
      activeHandles: 1,
      activeRequests: 1,
      eventLoopLagMs: 0
    },
    codeVersion: {},
    environment: {},
    ioEventsDropped: 0,
    captureFailures: [],
    alsContextAvailable: context !== undefined,
    stateTrackingEnabled: context !== undefined,
    usedAmbientEvents: context === undefined,
    ...overrides
  };
}

async function flushMicrotasks(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

class FakeWorker {
  private readonly messageListeners: Array<(message: PackageAssemblyWorkerResponse) => void> = [];

  private readonly errorListeners: Array<(error: Error) => void> = [];

  private readonly exitListeners: Array<(code: number) => void> = [];

  public constructor(
    private readonly handler: (
      message: PackageAssemblyWorkerRequest,
      workerData: PackageAssemblyWorkerData
    ) => PackageAssemblyWorkerResponse
  ,
    private readonly workerData: PackageAssemblyWorkerData
  ) {}

  public postMessage(message: PackageAssemblyWorkerRequest): void {
    queueMicrotask(() => {
      try {
        const response = this.handler(message, this.workerData);
        for (const listener of this.messageListeners) {
          listener(response);
        }

        if (message.type === 'shutdown') {
          for (const listener of this.exitListeners) {
            listener(0);
          }
        }
      } catch (error) {
        const workerError = error instanceof Error ? error : new Error(String(error));
        for (const listener of this.errorListeners) {
          listener(workerError);
        }
      }
    });
  }

  public on(
    event: 'message' | 'error' | 'exit',
    listener: ((message: PackageAssemblyWorkerResponse) => void) |
      ((error: Error) => void) |
      ((code: number) => void)
  ): this {
    if (event === 'message') {
      this.messageListeners.push(listener as (message: PackageAssemblyWorkerResponse) => void);
    } else if (event === 'error') {
      this.errorListeners.push(listener as (error: Error) => void);
    } else {
      this.exitListeners.push(listener as (code: number) => void);
    }

    return this;
  }

  public async terminate(): Promise<number> {
    for (const listener of this.exitListeners) {
      listener(0);
    }

    return 0;
  }
}

describe('ProcessMetadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GIT_SHA;
    delete process.env.npm_package_version;
  });

  it('collects and caches startup metadata using env-based git sha', () => {
    process.env.GIT_SHA = 'env-sha';
    process.env.npm_package_version = '1.2.3';

    const metadata = new ProcessMetadata(resolveConfig({}));
    const startup = metadata.getStartupMetadata();

    expect(startup).toMatchObject({
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid
    });
    expect(metadata.getCodeVersion()).toEqual({
      gitSha: 'env-sha',
      packageVersion: '1.2.3'
    });
  });

  it('reads git sha from .git/HEAD when env vars are absent', () => {
    const originalReadFileSync = fsModule.readFileSync;

    fsModule.readFileSync = vi
      .fn()
      .mockImplementationOnce(() => 'ref: refs/heads/main\n')
      .mockImplementationOnce(() => 'ref-file-sha\n') as typeof fsModule.readFileSync;

    try {
      const metadata = new ProcessMetadata(resolveConfig({}));

      expect(metadata.getCodeVersion().gitSha).toBe('ref-file-sha');
    } finally {
      fsModule.readFileSync = originalReadFileSync;
    }
  });

  it('collects fresh runtime metadata and measures event loop lag', () => {
    const timers = createTimeoutStubs();
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValueOnce(1000).mockReturnValueOnce(2004);

    const metadata = new ProcessMetadata(resolveConfig({}));

    metadata.startEventLoopLagMeasurement();
    timers.timers[0]?.fn();

    const runtime = metadata.getRuntimeMetadata();

    expect(runtime.memoryUsage.rss).toBeGreaterThan(0);
    expect(runtime.uptime).toBeGreaterThanOrEqual(0);
    expect(runtime.eventLoopLagMs).toBe(4);
    expect(timers.setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(timers.timers[0]?.unref).toHaveBeenCalledTimes(1);
  });

  it('shutdown stops lag measurement', () => {
    const timers = createTimeoutStubs();
    const metadata = new ProcessMetadata(resolveConfig({}));

    metadata.startEventLoopLagMeasurement();
    metadata.shutdown();

    expect(timers.clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PackageBuilder', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a scrubbed package with accurate completeness flags', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const als = new ALSManager();
    const context = createContext(als, 'req-1');

    context.url = '/login?email=user@example.com&token=secret-token';
    context.body = Buffer.from('email=user@example.com');
    context.bodyTruncated = true;
    context.stateReads.push({
      container: 'cache',
      operation: 'get',
      key: 'user',
      value: { token: 'secret-token' },
      timestamp: 1n
    });

    const pkg = builder.build({
      error: {
        type: 'Error',
        message: 'password leaked',
        stack: 'Error: password leaked',
        properties: { password: 'secret' }
      },
      localVariables: [
        {
          functionName: 'handler',
          filePath: '/app/src/handler.js',
          lineNumber: 1,
          columnNumber: 1,
          locals: { apiKey: 'secret-key' }
        }
      ],
      requestContext: context,
      ioTimeline: [
        createSlot({
          url: '/resource?apiKey=sk-secret',
          requestBody: Buffer.from('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'),
          responseBodyTruncated: true
        })
      ],
      stateReads: context.stateReads,
      concurrentRequests: [
        {
          requestId: 'req-2',
          method: 'GET',
          url: '/health',
          startTime: '1'
        }
      ],
      processMetadata: {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptime: 1,
        memoryUsage: {
          rss: 1,
          heapTotal: 1,
          heapUsed: 1,
          external: 1,
          arrayBuffers: 1
        },
        activeHandles: 1,
        activeRequests: 1,
        eventLoopLagMs: 0
      },
      codeVersion: { gitSha: 'sha', packageVersion: '1.0.0' },
      environment: { NODE_ENV: 'test' },
      ioEventsDropped: 3,
      captureFailures: [],
      alsContextAvailable: true,
      stateTrackingEnabled: true,
      usedAmbientEvents: false
    });

    expect(pkg.schemaVersion).toBe('1.0.0');
    expect(new Date(pkg.capturedAt).toISOString()).toBe(pkg.capturedAt);
    expect(pkg.error.properties.password).toBe('[REDACTED]');
    expect(pkg.localVariables?.[0]?.locals.apiKey).toBe('[REDACTED]');
    expect(pkg.request?.body).toEqual({
      _type: 'Buffer',
      encoding: 'base64',
      data: expect.any(String),
      length: Buffer.from('email=user@example.com').length
    });
    expect(pkg.request?.url).toBe('/login?email=%5BREDACTED%5D&token=%5BREDACTED%5D');
    expect(pkg.ioTimeline[0]?.url).toBe('/resource?apiKey=%5BREDACTED%5D');
    expect(pkg.completeness).toMatchObject({
      requestCaptured: true,
      requestBodyTruncated: true,
      ioTimelineCaptured: true,
      ioEventsDropped: 3,
      ioPayloadsTruncated: 1,
      alsContextAvailable: true,
      localVariablesCaptured: true,
      stateTrackingEnabled: true,
      stateReadsCaptured: true,
      piiScrubbed: true,
      encrypted: false
    });
  });

  it('progressively sheds oversized payloads to stay under the max size', () => {
    const config = resolveConfig({
      serialization: { maxTotalPackageSize: 950 }
    });
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const hugeBuffer = Buffer.alloc(4096, 'a');

    const pkg = builder.build({
      error: {
        type: 'Error',
        message: 'boom',
        stack: 'Error: boom',
        properties: {}
      },
      localVariables: null,
      requestContext: undefined,
      ioTimeline: [
        createSlot({
          requestId: null,
          requestBody: hugeBuffer,
          responseBody: hugeBuffer
        })
      ],
      stateReads: [
        {
          container: 'cache',
          operation: 'get',
          key: 'key',
          value: { large: 'x'.repeat(2048) },
          timestamp: 1n
        }
      ],
      concurrentRequests: [],
      processMetadata: {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptime: 1,
        memoryUsage: {
          rss: 1,
          heapTotal: 1,
          heapUsed: 1,
          external: 1,
          arrayBuffers: 1
        },
        activeHandles: 1,
        activeRequests: 1,
        eventLoopLagMs: 0
      },
      codeVersion: {},
      environment: {},
      ioEventsDropped: 0,
      captureFailures: [],
      alsContextAvailable: false,
      stateTrackingEnabled: false,
      usedAmbientEvents: true
    });

    expect(JSON.stringify(pkg).length).toBeLessThanOrEqual(900);
    expect(pkg.ioTimeline).toEqual([]);
    expect(pkg.stateReads).toEqual([]);
  });

  it('produces the same package and payload shape through the shared assembly helper', () => {
    const config = resolveConfig({});
    const builder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const als = new ALSManager();
    const context = createContext(als, 'req-assembly');

    context.body = Buffer.from('hello');
    const parts = createPackageParts(context, {
      ioTimeline: [createSlot({ requestBody: Buffer.from('body') })]
    });

    const inlineResult = finalizePackageAssemblyResult({
      packageObject: builder.build(parts),
      config
    });
    const sharedResult = buildPackageAssemblyResult({
      parts,
      config
    });

    expect(sharedResult.packageObject).toMatchObject({
      ...inlineResult.packageObject,
      capturedAt: expect.any(String),
      request: inlineResult.packageObject.request
        ? {
            ...inlineResult.packageObject.request,
            receivedAt: expect.any(String)
          }
        : undefined
    });
    expect(JSON.parse(sharedResult.payload)).toMatchObject({
      ...JSON.parse(inlineResult.payload),
      capturedAt: expect.any(String),
      request: inlineResult.packageObject.request
        ? {
            ...JSON.parse(inlineResult.payload).request,
            receivedAt: expect.any(String)
          }
        : undefined
    });
  });

  it('assembles packages through the dispatcher worker contract and shuts down cleanly', async () => {
    const config = resolveConfig({});
    const dispatcher = new PackageAssemblyDispatcher({
      config,
      workerFactory: {
        create: (_filename, workerData) =>
          new FakeWorker((message, data) => {
            if (message.type === 'shutdown') {
              return { id: message.id };
            }

            return {
              id: message.id,
              result: buildPackageAssemblyResult({
                parts: message.parts,
                config: data.config
              })
            };
          }, workerData)
      }
    });
    const als = new ALSManager();
    const context = createContext(als, 'req-dispatch');
    const parts = createPackageParts(context, {
      ioTimeline: [createSlot({ requestBody: Buffer.from('dispatch') })]
    });

    const result = await dispatcher.assemble(parts);

    expect(result.packageObject.request?.id).toBe('req-dispatch');
    expect(JSON.parse(result.payload)).toMatchObject({
      schemaVersion: '1.0.0'
    });

    await dispatcher.shutdown();
  });
});

describe('ErrorCapturer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures a full package with context, locals, io events, encryption, and transport handoff', () => {
    const config = resolveConfig({ encryptionKey: 'capture-secret' });
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-err');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const encryption = new Encryption('capture-secret');
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const inspector = {
      getLocals: vi.fn(() => [
        {
          functionName: 'handler',
          filePath: '/app/src/handler.js',
          lineNumber: 10,
          columnNumber: 1,
          locals: { password: 'secret', value: 1 }
        }
      ])
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: inspector as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption,
      bodyCapture: noopBodyCapture,
      config
    });

    context.body = Buffer.from('email=user@example.com');
    context.stateReads.push({
      container: 'cache',
      operation: 'get',
      key: 'user',
      value: { token: 'secret-token' },
      timestamp: 1n
    });
    tracker.add(context);
    buffer.push(
      createSlot({
        requestId: 'req-err',
        requestBody: Buffer.from('hello'),
        responseBody: Buffer.from('world'),
        estimatedBytes: 266
      })
    );

    const error = new Error('boom');
    (error as Error & { code?: string }).code = 'E_BANG';

    const pkg = als.runWithContext(context, () => capturer.capture(error));
    const sentPayload = transport.send.mock.calls[0]?.[0] as string;
    const decrypted = encryption.decrypt(JSON.parse(sentPayload) as {
      salt: string;
      iv: string;
      ciphertext: string;
      authTag: string;
    });

    expect(pkg).not.toBeNull();
    expect(pkg?.completeness.encrypted).toBe(true);
    expect(pkg?.integrity?.algorithm).toBe('HMAC-SHA256');
    expect(pkg?.request?.id).toBe('req-err');
    expect(pkg?.ioTimeline).toHaveLength(1);
    expect(pkg?.localVariables?.[0]?.locals.password).toBe('[REDACTED]');
    expect(pkg?.error.properties.code).toBe('E_BANG');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(decrypted)).toMatchObject({
      schemaVersion: '1.0.0',
      completeness: {
        encrypted: true
      }
    });

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('uses the package assembly dispatcher when available', async () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-worker');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(async (parts: ErrorPackageParts) =>
        buildPackageAssemblyResult({ parts, config })
      ),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-worker' }));

    const result = als.runWithContext(context, () => capturer.capture(new Error('worker')));

    expect(result).toBeNull();
    await flushMicrotasks();
    expect(dispatcher.assemble).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(1);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('falls back to inline package assembly when the worker path fails', async () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-fallback');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(async () => {
        throw new Error('worker boom');
      }),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-fallback' }));

    const result = als.runWithContext(context, () => capturer.capture(new Error('fallback')));

    expect(result).toBeNull();
    await flushMicrotasks();
    expect(transport.send).toHaveBeenCalledTimes(1);

    const payload = transport.send.mock.calls[0]?.[0] as string;
    expect(JSON.parse(payload)).toMatchObject({
      completeness: {
        captureFailures: ['package-worker: worker boom']
      }
    });

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('keeps inline assembly when a custom scrubber is configured', () => {
    const config = resolveConfig({
      piiScrubber: (_key, value) => value
    });
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const context = createContext(als, 'req-inline');
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const transport = {
      send: vi.fn()
    };
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const dispatcher = {
      isAvailable: vi.fn(() => true),
      assemble: vi.fn(),
      shutdown: vi.fn(async () => undefined)
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config,
      packageAssemblyDispatcher: dispatcher
    });

    tracker.add(context);
    buffer.push(createSlot({ requestId: 'req-inline' }));

    const result = als.runWithContext(context, () => capturer.capture(new Error('inline')));

    expect(result).not.toBeNull();
    expect(dispatcher.assemble).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledTimes(1);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('uses ambient events when ALS context is unavailable', () => {
    const config = resolveConfig({});
    const buffer = new IOEventBuffer({ capacity: 20, maxBytes: 1_000_000 });
    const als = new ALSManager();
    const tracker = new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 });
    const processMetadata = new ProcessMetadata(config);
    const packageBuilder = new PackageBuilder({
      scrubber: new Scrubber(config),
      config
    });
    const transport = {
      send: vi.fn()
    };
    const capturer = new ErrorCapturer({
      buffer,
      als,
      inspector: { getLocals: vi.fn(() => null) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: tracker,
      processMetadata,
      packageBuilder,
      transport,
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    buffer.push(createSlot({ requestId: null, target: 'ambient-1' }));
    buffer.push(createSlot({ requestId: null, target: 'ambient-2' }));

    const pkg = capturer.capture(new Error('ambient'));

    expect(pkg?.completeness.alsContextAvailable).toBe(false);
    expect(pkg?.request).toBeUndefined();
    expect(pkg?.ioTimeline.map((event) => event.target)).toEqual([
      'ambient-1',
      'ambient-2'
    ]);

    tracker.shutdown();
    processMetadata.shutdown();
  });

  it('returns null when rate limited', () => {
    const config = resolveConfig({});
    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 0, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({
        scrubber: new Scrubber(config),
        config
      }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    expect(capturer.capture(new Error('blocked'))).toBeNull();
  });

  it('serializes the error cause chain and enforces the depth limit', () => {
    const config = resolveConfig({});
    const root = new Error('root');
    let current: Error = root;

    for (let index = 0; index < 7; index += 1) {
      const next = new Error(`cause-${index}`);

      (current as Error & { cause?: Error }).cause = next;
      current = next;
    }

    const capturer = new ErrorCapturer({
      buffer: new IOEventBuffer({ capacity: 10, maxBytes: 100000 }),
      als: new ALSManager(),
      inspector: { getLocals: vi.fn(() => null) } as never,
      rateLimiter: new RateLimiter({ maxCaptures: 5, windowMs: 60_000 }),
      requestTracker: new RequestTracker({ maxConcurrent: 10, ttlMs: 60_000 }),
      processMetadata: new ProcessMetadata(config),
      packageBuilder: new PackageBuilder({
        scrubber: new Scrubber(config),
        config
      }),
      transport: { send: vi.fn() },
      encryption: null,
      bodyCapture: noopBodyCapture,
      config
    });

    const pkg = capturer.capture(root);

    expect(pkg?.error.cause?.message).toBe('cause-0');
    expect(pkg?.error.cause?.cause?.cause?.cause?.cause?.cause).toEqual({
      type: 'Error',
      message: '[Cause chain depth limit]',
      stack: '',
      properties: {}
    });
  });
});
