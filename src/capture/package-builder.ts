/**
 * @module 13-error-capture-pipeline
 * @spec spec/13-error-capture-pipeline.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts, io-event-buffer.ts, scrubber.ts,
 *               encryption.ts, rate-limiter.ts, als-manager.ts, request-tracker.ts, inspector-manager.ts
 */

import { createHmac } from 'node:crypto';

import { cloneAndLimit, STANDARD_LIMITS } from '../serialization/clone-and-limit';
import { Scrubber } from '../pii/scrubber';
import { Encryption } from '../security/encryption';
import type {
  CapturedFrame,
  Completeness,
  ErrorInfo,
  ErrorPackage,
  ErrorPackageParts,
  IOEventSlot,
  IOEventSerialized,
  PackageAssemblyResult,
  ProcessMetadata,
  RequestSummary,
  ResolvedConfig,
  StateRead,
  StateReadSerialized
} from '../types';

function cloneBufferBody(body: Buffer | null): unknown | null {
  return body === null ? null : cloneAndLimit(body, STANDARD_LIMITS);
}

function approximateIsoFromHrtime(startTime: bigint): string {
  const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;

  return new Date(Date.now() - elapsedMs).toISOString();
}

function serializeIOEvent(event: IOEventSlot, scrubber: Scrubber): IOEventSerialized {
  return {
    seq: event.seq,
    type: event.type,
    direction: event.direction,
    target: event.target,
    method: event.method,
    url: event.url === null ? null : scrubber.scrubUrl(event.url),
    statusCode: event.statusCode,
    fd: event.fd,
    requestId: event.requestId,
    contextLost: event.contextLost,
    startTime: event.startTime.toString(),
    endTime: event.endTime?.toString() ?? null,
    durationMs: event.durationMs,
    requestHeaders: event.requestHeaders === null ? null : { ...event.requestHeaders },
    responseHeaders: event.responseHeaders === null ? null : { ...event.responseHeaders },
    requestBody: cloneBufferBody(event.requestBody),
    responseBody: cloneBufferBody(event.responseBody),
    requestBodyDigest: event.requestBodyDigest ?? null,
    responseBodyDigest: event.responseBodyDigest ?? null,
    requestBodyTruncated: event.requestBodyTruncated,
    responseBodyTruncated: event.responseBodyTruncated,
    requestBodyOriginalSize: event.requestBodyOriginalSize,
    responseBodyOriginalSize: event.responseBodyOriginalSize,
    error: event.error === null ? null : { ...event.error },
    aborted: event.aborted,
    dbMeta: event.dbMeta === undefined ? undefined : { ...event.dbMeta }
  };
}

function serializeStateRead(read: StateRead): StateReadSerialized {
  return {
    container: read.container,
    operation: read.operation,
    key: cloneAndLimit(read.key, STANDARD_LIMITS),
    value: cloneAndLimit(read.value, STANDARD_LIMITS),
    timestamp: read.timestamp.toString()
  };
}

function estimateBodySize(body: unknown): number {
  if (body === null || body === undefined) {
    return 0;
  }

  if (typeof body === 'object' && body !== null && 'length' in body) {
    const length = (body as { length?: unknown }).length;

    if (typeof length === 'number') {
      return length;
    }
  }

  return JSON.stringify(body).length;
}

function signPackage(
  pkg: ErrorPackage,
  encryptionKey: string | undefined
): string | null {
  if (!encryptionKey) {
    return null;
  }

  return createHmac('sha256', encryptionKey)
    .update(JSON.stringify(pkg))
    .digest('base64');
}

export function finalizePackageAssemblyResult(input: {
  packageObject: ErrorPackage;
  config: ResolvedConfig;
}): PackageAssemblyResult {
  const { packageObject, config } = input;
  const integritySignature = signPackage(packageObject, config.encryptionKey);

  if (integritySignature !== null) {
    packageObject.integrity = {
      algorithm: 'HMAC-SHA256',
      signature: integritySignature
    };
  }

  packageObject.completeness.encrypted = config.encryptionKey !== undefined;

  const payload =
    config.encryptionKey === undefined
      ? JSON.stringify(packageObject)
      : JSON.stringify(new Encryption(config.encryptionKey).encrypt(JSON.stringify(packageObject)));

  return {
    packageObject,
    payload
  };
}

export function buildPackageAssemblyResult(input: {
  parts: ErrorPackageParts;
  config: ResolvedConfig;
}): PackageAssemblyResult {
  const scrubber = new Scrubber(input.config);
  const builder = new PackageBuilder({
    scrubber,
    config: input.config
  });

  return finalizePackageAssemblyResult({
    packageObject: builder.build(input.parts),
    config: input.config
  });
}

export class PackageBuilder {
  private readonly scrubber: Scrubber;

  private readonly config: ResolvedConfig;

  public constructor(deps: { scrubber: Scrubber; config: ResolvedConfig }) {
    this.scrubber = deps.scrubber;
    this.config = deps.config;
  }

  public build(parts: ErrorPackageParts): ErrorPackage {
    const serializedTimeline = parts.ioTimeline.map((event) =>
      serializeIOEvent(event, this.scrubber)
    );
    const serializedStateReads = parts.stateReads.map((read) =>
      serializeStateRead(read)
    );

    const packageObject: ErrorPackage = {
      schemaVersion: '1.0.0',
      capturedAt: new Date().toISOString(),
      error: {
        ...parts.error
      },
      localVariables: parts.localVariables ?? undefined,
      request:
        parts.requestContext === undefined
          ? undefined
          : {
              id: parts.requestContext.requestId,
              method: parts.requestContext.method,
              url: this.scrubber.scrubUrl(parts.requestContext.url),
              headers: { ...parts.requestContext.headers },
              body:
                parts.requestContext.body === null
                  ? undefined
                  : (cloneAndLimit(parts.requestContext.body, STANDARD_LIMITS) as
                      | string
                      | object),
              bodyTruncated: parts.requestContext.bodyTruncated || undefined,
              receivedAt: approximateIsoFromHrtime(parts.requestContext.startTime)
            },
      ioTimeline: serializedTimeline,
      stateReads: serializedStateReads,
      concurrentRequests: parts.concurrentRequests.map((summary) => ({ ...summary })),
      processMetadata: { ...parts.processMetadata },
      codeVersion: { ...parts.codeVersion },
      environment: { ...parts.environment },
      completeness: this.computeCompleteness(parts, false, {
        ioTimeline: serializedTimeline,
        stateReads: serializedStateReads
      })
    };

    const scrubbedPackage = this.scrubber.scrubObject(packageObject) as ErrorPackage;

    if ((scrubbedPackage as { request?: ErrorPackage['request'] | null }).request === null) {
      delete (scrubbedPackage as { request?: ErrorPackage['request'] | null }).request;
    }

    if (
      (scrubbedPackage as { localVariables?: ErrorPackage['localVariables'] | null })
        .localVariables === null
    ) {
      delete (scrubbedPackage as {
        localVariables?: ErrorPackage['localVariables'] | null;
      }).localVariables;
    }

    scrubbedPackage.completeness = this.computeCompleteness(parts, false, scrubbedPackage);
    this.shedIfNeeded(scrubbedPackage, parts);

    return scrubbedPackage;
  }

  private shedIfNeeded(pkg: ErrorPackage, parts: ErrorPackageParts): void {
    if (this.getPackageSize(pkg) <= this.config.serialization.maxTotalPackageSize) {
      return;
    }

    const eventsByBodySize = [...pkg.ioTimeline].sort((left, right) => {
      const leftSize =
        estimateBodySize(left.requestBody) + estimateBodySize(left.responseBody);
      const rightSize =
        estimateBodySize(right.requestBody) + estimateBodySize(right.responseBody);

      return rightSize - leftSize;
    });

    for (const event of eventsByBodySize) {
      if (this.getPackageSize(pkg) <= this.config.serialization.maxTotalPackageSize) {
        break;
      }

      if (event.requestBody !== null) {
        event.requestBody = null;
        event.requestBodyTruncated = true;
      }

      if (event.responseBody !== null) {
        event.responseBody = null;
        event.responseBodyTruncated = true;
      }
    }

    if (
      this.getPackageSize(pkg) > this.config.serialization.maxTotalPackageSize &&
      parts.usedAmbientEvents
    ) {
      pkg.ioTimeline = [];
    }

    if (this.getPackageSize(pkg) > this.config.serialization.maxTotalPackageSize) {
      pkg.stateReads = [];
    }

    pkg.completeness = this.computeCompleteness(
      parts,
      pkg.completeness.encrypted,
      pkg
    );
  }

  private computeCompleteness(
    parts: ErrorPackageParts,
    encrypted: boolean,
    pkg: Pick<ErrorPackage, 'request' | 'ioTimeline' | 'stateReads' | 'localVariables'>
  ): Completeness {
    const ioPayloadsTruncated = pkg.ioTimeline.reduce((count, event) => {
      return count + Number(event.requestBodyTruncated) + Number(event.responseBodyTruncated);
    }, 0);
    const stateTrackingEnabled = parts.stateTrackingEnabled;

    return {
      requestCaptured: pkg.request !== undefined,
      requestBodyTruncated: pkg.request?.bodyTruncated ?? false,
      ioTimelineCaptured: pkg.ioTimeline.length > 0,
      ioEventsDropped: parts.ioEventsDropped,
      ioPayloadsTruncated,
      alsContextAvailable: parts.alsContextAvailable,
      localVariablesCaptured:
        Array.isArray(pkg.localVariables) && pkg.localVariables.length > 0,
      localVariablesTruncated:
        (pkg.localVariables?.length ?? 0) >= this.config.maxLocalsFrames,
      stateTrackingEnabled,
      stateReadsCaptured: pkg.stateReads.length > 0,
      concurrentRequestsCaptured: true,
      piiScrubbed: true,
      encrypted,
      captureFailures: [...parts.captureFailures]
    };
  }

  private getPackageSize(pkg: ErrorPackage): number {
    return JSON.stringify(pkg).length;
  }
}
