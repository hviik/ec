/**
 * @module 13-error-capture-pipeline
 * @spec spec/13-error-capture-pipeline.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts, io-event-buffer.ts, scrubber.ts,
 *               encryption.ts, rate-limiter.ts, als-manager.ts, request-tracker.ts, inspector-manager.ts
 */

import { STANDARD_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import type { Encryption } from '../security/encryption';
import type { RateLimiter } from '../security/rate-limiter';
import type { ALSManager } from '../context/als-manager';
import type { RequestTracker } from '../context/request-tracker';
import type { InspectorManager } from './inspector-manager';
import { finalizePackageAssemblyResult } from './package-builder';
import type { PackageBuilder } from './package-builder';
import type { ProcessMetadata } from './process-metadata';
import type {
  ErrorInfo,
  ErrorPackage,
  ErrorPackageParts,
  ErrorPackageRequestContextData,
  IOEventSlot,
  PackageAssemblyResult,
  RequestContext,
  ResolvedConfig
} from '../types';

interface IOEventBufferLike {
  filterByRequestId(requestId: string): IOEventSlot[];
  getRecent(count: number): IOEventSlot[];
  getOverflowCount(): number;
}

interface TransportLike {
  send(payload: string): void;
}

interface BodyCaptureLike {
  materializeSlotBodies(slot: IOEventSlot): void;
  materializeContextBody(context: RequestContext): void;
}

interface PackageAssemblyDispatcherLike {
  isAvailable(): boolean;
  assemble(
    parts: ErrorPackageParts,
    options?: { timeoutMs?: number }
  ): Promise<PackageAssemblyResult>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

function extractCustomProperties(error: Error): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
      continue;
    }

    try {
      properties[key] = (error as unknown as Record<string, unknown>)[key];
    } catch (propertyError) {
      properties[key] =
        propertyError instanceof Error
          ? `[Serialization error: ${propertyError.message}]`
          : '[Serialization error]';
    }
  }

  return properties;
}

function serializeError(error: Error, depth = 0): ErrorInfo {
  if (depth > 5) {
    return {
      type: 'Error',
      message: '[Cause chain depth limit]',
      stack: '',
      properties: {}
    };
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  return {
    type: error.constructor?.name || 'Error',
    message: error.message || '',
    stack: error.stack || '',
    cause: cause instanceof Error ? serializeError(cause, depth + 1) : undefined,
    properties: cloneAndLimit(extractCustomProperties(error), STANDARD_LIMITS) as Record<
      string,
      unknown
    >
  };
}

export class ErrorCapturer {
  private readonly buffer: IOEventBufferLike;

  private readonly als: ALSManager;

  private readonly inspector: InspectorManager;

  private readonly rateLimiter: RateLimiter;

  private readonly requestTracker: RequestTracker;

  private readonly processMetadata: ProcessMetadata;

  private readonly packageBuilder: PackageBuilder;

  private readonly transport: TransportLike;

  private readonly encryption: Encryption | null;

  private readonly bodyCapture: BodyCaptureLike;

  private readonly config: ResolvedConfig;

  private readonly packageAssemblyDispatcher: PackageAssemblyDispatcherLike | null;

  public constructor(deps: {
    buffer: IOEventBufferLike;
    als: ALSManager;
    inspector: InspectorManager;
    rateLimiter: RateLimiter;
    requestTracker: RequestTracker;
    processMetadata: ProcessMetadata;
    packageBuilder: PackageBuilder;
    transport: TransportLike;
    encryption?: Encryption | null;
    bodyCapture: BodyCaptureLike;
    config: ResolvedConfig;
    packageAssemblyDispatcher?: PackageAssemblyDispatcherLike | null;
  }) {
    this.buffer = deps.buffer;
    this.als = deps.als;
    this.inspector = deps.inspector;
    this.rateLimiter = deps.rateLimiter;
    this.requestTracker = deps.requestTracker;
    this.processMetadata = deps.processMetadata;
    this.packageBuilder = deps.packageBuilder;
    this.transport = deps.transport;
    this.encryption = deps.encryption ?? null;
    this.bodyCapture = deps.bodyCapture;
    this.config = deps.config;
    this.packageAssemblyDispatcher = deps.packageAssemblyDispatcher ?? null;
  }

  public capture(error: Error, _options?: { isUncaught?: boolean }): ErrorPackage | null {
    const captureFailures: string[] = [];

    try {
      if (!this.rateLimiter.tryAcquire()) {
        return null;
      }

      const serializedError = serializeError(error);
      const locals = this.safeGetLocals(error, captureFailures);
      const context = this.safeGetContext(captureFailures);
      const usedAmbientEvents = context === undefined;
      const ioTimeline = context === undefined
        ? this.buffer.getRecent(20)
        : this.buffer.filterByRequestId(context.requestId);
      if (context !== undefined) {
        this.bodyCapture.materializeContextBody(context);
      }
      for (const event of ioTimeline) {
        this.bodyCapture.materializeSlotBodies(event);
      }
      const stateReads = context?.stateReads ?? [];
      const concurrentRequests = this.requestTracker.getSummaries();
      const parts: ErrorPackageParts = {
        error: {
          type: serializedError.type,
          message: serializedError.message,
          stack: serializedError.stack,
          cause: serializedError.cause,
          properties: serializedError.properties
        },
        localVariables: locals,
        requestContext: this.toRequestContextData(context),
        ioTimeline,
        stateReads,
        concurrentRequests,
        processMetadata: this.processMetadata.getMergedMetadata(),
        codeVersion: this.processMetadata.getCodeVersion(),
        environment: this.processMetadata.getEnvironment(),
        ioEventsDropped: this.buffer.getOverflowCount(),
        captureFailures,
        alsContextAvailable: context !== undefined,
        stateTrackingEnabled: context !== undefined,
        usedAmbientEvents
      };

      if (
        this.packageAssemblyDispatcher !== null &&
        this.packageAssemblyDispatcher.isAvailable() &&
        this.config.piiScrubber === undefined
      ) {
        void this.dispatchPackageAssembly(parts);
        return null;
      }

      return this.captureInline(parts);
    } catch (captureError) {
      const message =
        captureError instanceof Error ? captureError.message : String(captureError);

      console.warn(`[ECD] Error capture failed: ${message}`);
      return null;
    }
  }

  private safeGetLocals(error: Error, captureFailures: string[]) {
    try {
      return this.inspector.getLocals(error);
    } catch (inspectorError) {
      const message =
        inspectorError instanceof Error ? inspectorError.message : String(inspectorError);

      captureFailures.push(`locals: ${message}`);
      return null;
    }
  }

  private safeGetContext(captureFailures: string[]): RequestContext | undefined {
    try {
      return this.als.getContext();
    } catch (alsError) {
      const message = alsError instanceof Error ? alsError.message : String(alsError);

      captureFailures.push(`als: ${message}`);
      return undefined;
    }
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (this.packageAssemblyDispatcher === null) {
      return;
    }

    await this.packageAssemblyDispatcher.shutdown(options);
  }

  private toRequestContextData(
    context: RequestContext | undefined
  ): ErrorPackageRequestContextData | undefined {
    if (context === undefined) {
      return undefined;
    }

    return {
      requestId: context.requestId,
      startTime: context.startTime,
      method: context.method,
      url: context.url,
      headers: { ...context.headers },
      body: context.body,
      bodyTruncated: context.bodyTruncated
    };
  }

  private captureInline(parts: ErrorPackageParts): ErrorPackage {
    const { packageObject, payload } = finalizePackageAssemblyResult({
      packageObject: this.packageBuilder.build(parts),
      config: this.config
    });
    this.dispatchTransport(packageObject, payload);
    return packageObject;
  }

  private async dispatchPackageAssembly(parts: ErrorPackageParts): Promise<void> {
    try {
      const result = await this.packageAssemblyDispatcher?.assemble(parts);

      if (result === undefined) {
        throw new Error('Package assembly worker returned no result');
      }

      this.dispatchTransport(result.packageObject, result.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parts.captureFailures.push(`package-worker: ${message}`);

      try {
        this.captureInline(parts);
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        console.warn(`[ECD] Error capture fallback failed: ${fallbackMessage}`);
      }
    }
  }

  private dispatchTransport(packageObject: ErrorPackage, payload: string): void {
    try {
      this.transport.send(payload);
    } catch (transportError) {
      const message =
        transportError instanceof Error ? transportError.message : String(transportError);

      packageObject.completeness.captureFailures.push(`transport: ${message}`);
    }
  }
}
