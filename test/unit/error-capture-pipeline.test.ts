import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config';
import { Scrubber } from '../../src/pii/scrubber';
import { Encryption } from '../../src/security/encryption';
import { RateLimiter } from '../../src/security/rate-limiter';
import { ALSManager } from '../../src/context/als-manager';
import { RequestTracker } from '../../src/context/request-tracker';
import { IOEventBuffer } from '../../src/buffer/io-event-buffer';
import { PackageBuilder } from '../../src/capture/package-builder';
import { ProcessMetadata } from '../../src/capture/process-metadata';
import { ErrorCapturer } from '../../src/capture/error-capturer';
import type { IOEventSlot, RequestContext } from '../../src/types';

const require = createRequire(import.meta.url);
const fsModule = require('node:fs') as typeof import('node:fs');

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

    now.mockReturnValueOnce(1000).mockReturnValueOnce(1004);

    const metadata = new ProcessMetadata(resolveConfig({}));

    metadata.startEventLoopLagMeasurement();
    timers.timers[0]?.fn();

    const runtime = metadata.getRuntimeMetadata();

    expect(runtime.memoryUsage.rss).toBeGreaterThan(0);
    expect(runtime.uptime).toBeGreaterThanOrEqual(0);
    expect(runtime.eventLoopLagMs).toBe(4);
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
});

describe('ErrorCapturer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures a full package with context, locals, io events, encryption, and transport handoff', () => {
    const config = resolveConfig({});
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
