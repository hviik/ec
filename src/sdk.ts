/**
 * @module 16-sdk-composition
 * @spec spec/16-sdk-composition.md
 * @dependencies ALL modules (01-15)
 */

import { resolveConfig } from './config';
import { IOEventBuffer } from './buffer/io-event-buffer';
import { ALSManager } from './context/als-manager';
import { RequestTracker } from './context/request-tracker';
import { HeaderFilter } from './pii/header-filter';
import { Scrubber } from './pii/scrubber';
import { RateLimiter } from './security/rate-limiter';
import { Encryption } from './security/encryption';
import { ProcessMetadata } from './capture/process-metadata';
import { InspectorManager } from './capture/inspector-manager';
import { BodyCapture } from './recording/body-capture';
import { StateTracker } from './state/state-tracker';
import { HttpServerRecorder } from './recording/http-server';
import { HttpClientRecorder } from './recording/http-client';
import { UndiciRecorder } from './recording/undici';
import { NetDnsRecorder } from './recording/net-dns';
import { PatchManager } from './recording/patches/patch-manager';
import { ChannelSubscriber } from './recording/channel-subscriber';
import { PackageBuilder } from './capture/package-builder';
import { TransportDispatcher } from './transport/transport';
import { ErrorCapturer } from './capture/error-capturer';
import type { RequestContext, ResolvedConfig, SDKConfig } from './types';

type SDKState = 'created' | 'active' | 'shutting_down' | 'shutdown';

interface ProcessListenerEntry {
  event: NodeJS.Signals | 'uncaughtException' | 'unhandledRejection' | 'beforeExit' | 'exit';
  handler: (...args: any[]) => void;
  once?: boolean;
}

export class SDKInstance {
  private state: SDKState = 'created';

  private readonly timers: Array<NodeJS.Timeout | NodeJS.Timer> = [];

  private readonly processListeners: ProcessListenerEntry[] = [];

  private readonly httpServerRecorder: HttpServerRecorder;

  private readonly httpClientRecorder: HttpClientRecorder;

  private readonly undiciRecorder: UndiciRecorder;

  private readonly netDnsRecorder: NetDnsRecorder;

  readonly config: ResolvedConfig;

  readonly buffer: IOEventBuffer;

  readonly als: ALSManager;

  readonly requestTracker: RequestTracker;

  readonly inspector: InspectorManager;

  readonly channelSubscriber: ChannelSubscriber;

  readonly patchManager: PatchManager;

  readonly stateTracker: StateTracker;

  readonly errorCapturer: ErrorCapturer;

  readonly transport: TransportDispatcher;

  readonly processMetadata: ProcessMetadata;

  public constructor(input: {
    config: ResolvedConfig;
    buffer: IOEventBuffer;
    als: ALSManager;
    requestTracker: RequestTracker;
    inspector: InspectorManager;
    channelSubscriber: ChannelSubscriber;
    patchManager: PatchManager;
    stateTracker: StateTracker;
    errorCapturer: ErrorCapturer;
    transport: TransportDispatcher;
    processMetadata: ProcessMetadata;
    httpServerRecorder: HttpServerRecorder;
    httpClientRecorder: HttpClientRecorder;
    undiciRecorder: UndiciRecorder;
    netDnsRecorder: NetDnsRecorder;
  }) {
    this.config = input.config;
    this.buffer = input.buffer;
    this.als = input.als;
    this.requestTracker = input.requestTracker;
    this.inspector = input.inspector;
    this.channelSubscriber = input.channelSubscriber;
    this.patchManager = input.patchManager;
    this.stateTracker = input.stateTracker;
    this.errorCapturer = input.errorCapturer;
    this.transport = input.transport;
    this.processMetadata = input.processMetadata;
    this.httpServerRecorder = input.httpServerRecorder;
    this.httpClientRecorder = input.httpClientRecorder;
    this.undiciRecorder = input.undiciRecorder;
    this.netDnsRecorder = input.netDnsRecorder;
  }

  public activate(): void {
    if (this.state !== 'created') {
      return;
    }

    this.processMetadata.collectStartupMetadata();
    this.channelSubscriber.subscribeAll();
    this.patchManager.installAll();
    this.registerProcessHandlers();
    this.processMetadata.startEventLoopLagMeasurement();

    if (!this.config.encryptionKey) {
      process.stderr.write('[ECD] Warning: encryption is disabled\n');
    }

    this.state = 'active';
  }

  public captureError(error: Error): void {
    if (this.state !== 'active') {
      return;
    }

    this.errorCapturer.capture(error);
  }

  public trackState<T extends Map<unknown, unknown> | Record<string, unknown>>(
    name: string,
    container: T
  ): T {
    if (this.state === 'shutdown') {
      throw new Error('SDK is shut down');
    }

    return this.stateTracker.track(name, container);
  }

  public withContext<T>(fn: () => T): T {
    const context = this.als.createRequestContext({
      method: 'INTERNAL',
      url: 'withContext',
      headers: {}
    });

    return this.als.runWithContext(context as RequestContext, fn);
  }

  public isActive(): boolean {
    return this.state === 'active';
  }

  public async shutdown(): Promise<void> {
    if (this.state === 'shutdown' || this.state === 'shutting_down') {
      return;
    }

    this.state = 'shutting_down';

    this.channelSubscriber.unsubscribeAll();
    this.patchManager.unwrapAll();
    this.httpServerRecorder.shutdown();
    this.httpClientRecorder.shutdown();
    this.undiciRecorder.shutdown();
    this.netDnsRecorder.shutdown();
    this.inspector.shutdown();
    this.processMetadata.shutdown();
    this.requestTracker.shutdown();

    for (const timer of this.timers) {
      clearTimeout(timer as NodeJS.Timeout);
    }

    await this.transport.flush();
    await this.transport.shutdown({ timeoutMs: 5000 });
    this.buffer.clear();

    for (const listener of this.processListeners) {
      process.removeListener(listener.event, listener.handler);
    }

    this.processListeners.length = 0;
    this.state = 'shutdown';
  }

  public enableAutoShutdown(): void {
    const sigtermHandler = async () => {
      await this.shutdown();
      process.kill(process.pid, 'SIGTERM');
    };
    const sigintHandler = async () => {
      await this.shutdown();
      process.kill(process.pid, 'SIGINT');
    };

    process.once('SIGTERM', sigtermHandler);
    process.once('SIGINT', sigintHandler);
    this.processListeners.push({ event: 'SIGTERM', handler: sigtermHandler, once: true });
    this.processListeners.push({ event: 'SIGINT', handler: sigintHandler, once: true });
  }

  private registerProcessHandlers(): void {
    const uncaughtExceptionHandler = (error: Error) => {
      this.errorCapturer.capture(error, { isUncaught: true });
    };
    const unhandledRejectionHandler = (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));

      this.errorCapturer.capture(error);
    };
    const beforeExitHandler = () => {
      void this.shutdown();
    };
    const exitHandler = () => {
      if (this.state === 'active') {
        this.transport.sendSync(
          JSON.stringify({
            schemaVersion: '1.0.0',
            capturedAt: new Date().toISOString(),
            error: {
              type: 'ProcessExit',
              message: 'Process exited before SDK shutdown completed',
              stack: '',
              properties: {}
            }
          })
        );
      }
    };

    process.on('uncaughtException', uncaughtExceptionHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);
    process.on('beforeExit', beforeExitHandler);
    process.on('exit', exitHandler);

    this.processListeners.push({ event: 'uncaughtException', handler: uncaughtExceptionHandler });
    this.processListeners.push({ event: 'unhandledRejection', handler: unhandledRejectionHandler });
    this.processListeners.push({ event: 'beforeExit', handler: beforeExitHandler });
    this.processListeners.push({ event: 'exit', handler: exitHandler });
  }
}

export function createSDK(userConfig: Partial<SDKConfig> = {}): SDKInstance {
  const config = resolveConfig(userConfig);
  const buffer = new IOEventBuffer({
    capacity: config.bufferSize,
    maxBytes: config.bufferMaxBytes
  });
  const als = new ALSManager();
  const headerFilter = new HeaderFilter(config);
  const scrubber = new Scrubber(config);
  const rateLimiter = new RateLimiter({
    maxCaptures: config.rateLimitPerMinute,
    windowMs: 60000
  });
  const encryption = config.encryptionKey ? new Encryption(config.encryptionKey) : null;
  const processMetadata = new ProcessMetadata(config);
  const inspector = new InspectorManager(config);
  const requestTracker = new RequestTracker({
    maxConcurrent: config.maxConcurrentRequests,
    ttlMs: 300000
  });
  const bodyCapture = new BodyCapture({
    maxPayloadSize: config.maxPayloadSize,
    captureBody: config.captureBody
  });
  const stateTracker = new StateTracker({ als });
  const httpServerRecorder = new HttpServerRecorder({
    buffer,
    als,
    requestTracker,
    bodyCapture,
    headerFilter,
    config
  });
  const httpClientRecorder = new HttpClientRecorder({
    buffer,
    als,
    bodyCapture,
    headerFilter
  });
  const undiciRecorder = new UndiciRecorder({
    buffer,
    als,
    headerFilter
  });
  const netDnsRecorder = new NetDnsRecorder({
    buffer,
    als
  });
  const patchManager = new PatchManager({ buffer, als, config });
  const channelSubscriber = new ChannelSubscriber({
    httpServer: httpServerRecorder,
    httpClient: httpClientRecorder,
    undiciRecorder,
    netDns: netDnsRecorder
  });
  const packageBuilder = new PackageBuilder({ scrubber, config });
  const transport = new TransportDispatcher({ config, encryption });
  const errorCapturer = new ErrorCapturer({
    buffer,
    als,
    inspector,
    rateLimiter,
    requestTracker,
    processMetadata,
    packageBuilder,
    transport,
    encryption,
    config
  });

  return new SDKInstance({
    config,
    buffer,
    als,
    requestTracker,
    inspector,
    channelSubscriber,
    patchManager,
    stateTracker,
    errorCapturer,
    transport,
    processMetadata,
    httpServerRecorder,
    httpClientRecorder,
    undiciRecorder,
    netDnsRecorder
  });
}
