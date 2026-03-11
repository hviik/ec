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
import type { PackageBuilder } from './package-builder';
import type { ProcessMetadata } from './process-metadata';
import type { ErrorInfo, ErrorPackage, IOEventSlot, RequestContext, ResolvedConfig } from '../types';

interface IOEventBufferLike {
  filterByRequestId(requestId: string): IOEventSlot[];
  getRecent(count: number): IOEventSlot[];
  getOverflowCount(): number;
}

interface TransportLike {
  send(payload: string): void;
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

  private readonly config: ResolvedConfig;

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
    config: ResolvedConfig;
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
    this.config = deps.config;
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
      const stateReads = context?.stateReads ?? [];
      const concurrentRequests = this.requestTracker.getSummaries();
      const packageObject = this.packageBuilder.build({
        error: {
          type: serializedError.type,
          message: serializedError.message,
          stack: serializedError.stack,
          cause: serializedError.cause,
          properties: serializedError.properties
        },
        localVariables: locals,
        requestContext: context,
        ioTimeline,
        stateReads,
        concurrentRequests,
        processMetadata: this.processMetadata.getMergedMetadata(),
        codeVersion: this.processMetadata.getCodeVersion(),
        environment: this.processMetadata.getEnvironment(),
        ioEventsDropped: this.buffer.getOverflowCount(),
        captureFailures,
        alsContextAvailable: context !== undefined,
        stateTrackingEnabled: stateReads.length > 0,
        usedAmbientEvents
      });

      packageObject.completeness.encrypted = this.encryption !== null;

      const payload =
        this.encryption === null
          ? JSON.stringify(packageObject)
          : JSON.stringify(this.encryption.encrypt(JSON.stringify(packageObject)));

      try {
        this.transport.send(payload);
      } catch (transportError) {
        const message =
          transportError instanceof Error ? transportError.message : String(transportError);

        packageObject.completeness.captureFailures.push(`transport: ${message}`);
      }

      return packageObject;
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
}
