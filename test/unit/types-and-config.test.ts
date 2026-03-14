import { describe, expect, it } from 'vitest';

import { resolveConfig } from '../../src/config';
import type {
  ErrorInfo,
  ErrorPackage,
  IOEventSerialized,
  ProcessMetadata,
  RequestSummary,
  ResolvedConfig,
  SerializationLimits,
  StateReadSerialized,
  TransportConfig
} from '../../src/types';

describe('resolveConfig', () => {
  it('returns the full default configuration', () => {
    const resolved = resolveConfig({});

    expect(resolved).toEqual({
      bufferSize: 200,
      bufferMaxBytes: 52428800,
      maxPayloadSize: 32768,
      maxConcurrentRequests: 50,
      rateLimitPerMinute: 10,
      headerAllowlist: [
        'content-type',
        'content-length',
        'accept',
        'user-agent',
        'x-request-id',
        'x-correlation-id',
        'host'
      ],
      headerBlocklist: [
        /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
        /auth|token|key|secret|password|credential/i
      ],
      envAllowlist: [
        'NODE_ENV',
        'NODE_VERSION',
        'PORT',
        'HOST',
        'TZ',
        'LANG',
        'npm_package_version'
      ],
      envBlocklist: [/key|secret|token|password|credential|auth|private/i],
      encryptionKey: undefined,
      allowUnencrypted: false,
      transport: { type: 'stdout' },
      captureLocalVariables: false,
      captureDbBindParams: false,
      captureBody: true,
      captureBodyDigest: false,
      bodyCaptureContentTypes: [
        'application/json',
        'application/x-www-form-urlencoded',
        'text/plain',
        'application/xml',
        'multipart/form-data'
      ],
      piiScrubber: undefined,
      replaceDefaultScrubber: false,
      serialization: {
        maxDepth: 8,
        maxArrayItems: 20,
        maxObjectKeys: 50,
        maxStringLength: 2048,
        maxPayloadSize: 32768,
        maxTotalPackageSize: 5242880
      },
      maxLocalsCollectionsPerSecond: 20,
      maxCachedLocals: 50,
      maxLocalsFrames: 5,
      uncaughtExceptionExitDelayMs: 500,
      allowInsecureTransport: false
    });
  });

  it('merges user config over defaults', () => {
    const resolved = resolveConfig({
      bufferSize: 500,
      captureBody: false,
      captureBodyDigest: true,
      bodyCaptureContentTypes: ['application/json'],
      serialization: { maxDepth: 4 },
      transport: { type: 'file', path: '/tmp/ecd.log' }
    });

    expect(resolved.bufferSize).toBe(500);
    expect(resolved.captureBody).toBe(false);
    expect(resolved.captureBodyDigest).toBe(true);
    expect(resolved.bodyCaptureContentTypes).toEqual(['application/json']);
    expect(resolved.serialization).toEqual({
      maxDepth: 4,
      maxArrayItems: 20,
      maxObjectKeys: 50,
      maxStringLength: 2048,
      maxPayloadSize: 32768,
      maxTotalPackageSize: 5242880
    });
    expect(resolved.transport).toEqual({ type: 'file', path: '/tmp/ecd.log' });
  });

  it('rejects invalid numeric values with descriptive errors', () => {
    expect(() => resolveConfig({ bufferSize: 0 })).toThrow(
      'bufferSize must be a positive integer'
    );
    expect(() => resolveConfig({ bufferSize: 9 })).toThrow(
      'bufferSize must be between 10 and 100000'
    );
    expect(() => resolveConfig({ bufferMaxBytes: 1048575 })).toThrow(
      'bufferMaxBytes must be at least 1048576'
    );
    expect(() => resolveConfig({ maxPayloadSize: 1023 })).toThrow(
      'maxPayloadSize must be at least 1024'
    );
    expect(() =>
      resolveConfig({ bufferMaxBytes: 1048576, maxPayloadSize: 1048577 })
    ).toThrow('maxPayloadSize must be less than or equal to bufferMaxBytes');
    expect(() =>
      resolveConfig({ serialization: { maxArrayItems: 0 } })
    ).toThrow('serialization.maxArrayItems must be a positive integer');
  });

  it('keeps the default header blocklist effective even when allowlisted', () => {
    const resolved = resolveConfig({
      headerAllowlist: ['authorization', 'content-type']
    });

    expect(resolved.headerAllowlist).toContain('authorization');
    expect(
      resolved.headerBlocklist.some((pattern) => pattern.test('authorization'))
    ).toBe(true);
  });

  it('ignores unknown keys', () => {
    const resolved = resolveConfig({
      bufferSize: 250,
      // @ts-expect-error verifying unknown keys are ignored at runtime
      unknownKey: 'ignored'
    });

    expect(resolved.bufferSize).toBe(250);
    expect('unknownKey' in resolved).toBe(false);
  });

  it('rejects HTTP transport in local-only mode', () => {
    expect(() =>
      resolveConfig({
        transport: { type: 'http', url: 'https://example.com/collect' }
      })
    ).toThrow(
      'HTTP transport is not supported in local-only mode. Use "stdout" or "file" transport.'
    );
  });
});

describe('type exports', () => {
  it('exports the shared interfaces successfully', () => {
    const transportConfig: TransportConfig = { type: 'stdout' };
    const requestSummary: RequestSummary = {
      requestId: 'req-1',
      method: 'GET',
      url: '/health',
      startTime: '1'
    };
    const processMetadata: ProcessMetadata = {
      nodeVersion: 'v20.0.0',
      v8Version: '11.0',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      uptime: 1,
      memoryUsage: {
        rss: 1,
        heapTotal: 1,
        heapUsed: 1,
        external: 1,
        arrayBuffers: 1
      },
      activeHandles: 1,
      activeRequests: 0,
      eventLoopLagMs: 0
    };
    const errorInfo: ErrorInfo = {
      type: 'Error',
      message: 'boom',
      stack: 'stack',
      properties: {}
    };
    const ioEvent: IOEventSerialized = {
      seq: 1,
      type: 'http-server',
      direction: 'inbound',
      target: 'service',
      method: 'GET',
      url: '/health',
      statusCode: 200,
      fd: null,
      requestId: 'req-1',
      contextLost: false,
      startTime: '1',
      endTime: '2',
      durationMs: 1,
      requestHeaders: { host: 'localhost' },
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      requestBodyTruncated: false,
      responseBodyTruncated: false,
      requestBodyOriginalSize: null,
      responseBodyOriginalSize: null,
      error: null,
      aborted: false
    };
    const stateRead: StateReadSerialized = {
      container: 'cache',
      operation: 'get',
      key: 'user:1',
      value: { id: 1 },
      timestamp: '1'
    };
    const limits: SerializationLimits = {
      maxDepth: 1,
      maxArrayItems: 1,
      maxObjectKeys: 1,
      maxStringLength: 1,
      maxPayloadSize: 1024,
      maxTotalPackageSize: 1024
    };
    const resolved: ResolvedConfig = resolveConfig({});
    const errorPackage: ErrorPackage = {
      schemaVersion: '1.0.0',
      capturedAt: '2026-01-01T00:00:00.000Z',
      error: {
        type: errorInfo.type,
        message: errorInfo.message,
        stack: errorInfo.stack,
        properties: errorInfo.properties
      },
      ioTimeline: [ioEvent],
      stateReads: [stateRead],
      concurrentRequests: [requestSummary],
      processMetadata,
      codeVersion: {},
      environment: {},
      completeness: {
        requestCaptured: false,
        requestBodyTruncated: false,
        ioTimelineCaptured: true,
        ioEventsDropped: 0,
        ioPayloadsTruncated: 0,
        alsContextAvailable: false,
        localVariablesCaptured: false,
        localVariablesTruncated: false,
        stateTrackingEnabled: false,
        stateReadsCaptured: false,
        concurrentRequestsCaptured: false,
        piiScrubbed: true,
        encrypted: false,
        captureFailures: []
      }
    };

    expect(transportConfig.type).toBe('stdout');
    expect(requestSummary.requestId).toBe('req-1');
    expect(processMetadata.pid).toBe(1);
    expect(errorPackage.schemaVersion).toBe('1.0.0');
    expect(limits.maxPayloadSize).toBe(1024);
    expect(resolved.transport.type).toBe('stdout');
  });
});
