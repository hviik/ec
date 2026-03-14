/**
 * @module 01-types-and-config
 * @spec spec/01-types-and-config.md
 * @dependencies none
 */

import type { ResolvedConfig, SDKConfig, SerializationLimits } from './types';

const DEFAULT_SERIALIZATION: SerializationLimits = {
  maxDepth: 8,
  maxArrayItems: 20,
  maxObjectKeys: 50,
  maxStringLength: 2048,
  maxPayloadSize: 32768,
  maxTotalPackageSize: 5242880
};

const DEFAULT_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'accept',
  'user-agent',
  'x-request-id',
  'x-correlation-id',
  'host'
];

const DEFAULT_HEADER_BLOCKLIST = [
  /authorization|cookie|set-cookie|x-api-key|x-auth-token/i,
  /auth|token|key|secret|password|credential/i
];

const DEFAULT_ENV_ALLOWLIST = [
  'NODE_ENV',
  'NODE_VERSION',
  'PORT',
  'HOST',
  'TZ',
  'LANG',
  'npm_package_version'
];

const DEFAULT_ENV_BLOCKLIST = [/key|secret|token|password|credential|auth|private/i];

const DEFAULT_BODY_CAPTURE_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
  'application/xml',
  'multipart/form-data'
];

function assertPositiveInteger(
  value: number,
  fieldName: string,
  extraConstraint?: (candidate: number) => string | null
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  if (extraConstraint) {
    const message = extraConstraint(value);

    if (message !== null) {
      throw new Error(message);
    }
  }
}

function resolveSerializationLimits(
  userConfig: Partial<SDKConfig>
): SerializationLimits {
  const resolved: SerializationLimits = {
    ...DEFAULT_SERIALIZATION,
    ...userConfig.serialization
  };

  assertPositiveInteger(resolved.maxDepth, 'serialization.maxDepth');
  assertPositiveInteger(resolved.maxArrayItems, 'serialization.maxArrayItems');
  assertPositiveInteger(resolved.maxObjectKeys, 'serialization.maxObjectKeys');
  assertPositiveInteger(resolved.maxStringLength, 'serialization.maxStringLength');
  assertPositiveInteger(resolved.maxPayloadSize, 'serialization.maxPayloadSize');
  assertPositiveInteger(
    resolved.maxTotalPackageSize,
    'serialization.maxTotalPackageSize'
  );

  return resolved;
}

export function resolveConfig(userConfig: Partial<SDKConfig> = {}): ResolvedConfig {
  const transport = userConfig.transport ?? { type: 'stdout' };
  const bufferSize = userConfig.bufferSize ?? 200;
  const bufferMaxBytes = userConfig.bufferMaxBytes ?? 52428800;
  const maxPayloadSize = userConfig.maxPayloadSize ?? 32768;
  const maxConcurrentRequests = userConfig.maxConcurrentRequests ?? 50;
  const rateLimitPerMinute = userConfig.rateLimitPerMinute ?? 10;
  const maxLocalsCollectionsPerSecond =
    userConfig.maxLocalsCollectionsPerSecond ?? 20;
  const maxCachedLocals = userConfig.maxCachedLocals ?? 50;
  const maxLocalsFrames = userConfig.maxLocalsFrames ?? 5;
  const uncaughtExceptionExitDelayMs =
    userConfig.uncaughtExceptionExitDelayMs ?? 500;

  assertPositiveInteger(bufferSize, 'bufferSize', (candidate) => {
    if (candidate < 10 || candidate > 100000) {
      return 'bufferSize must be between 10 and 100000';
    }

    return null;
  });

  assertPositiveInteger(bufferMaxBytes, 'bufferMaxBytes', (candidate) => {
    if (candidate < 1048576) {
      return 'bufferMaxBytes must be at least 1048576';
    }

    return null;
  });

  assertPositiveInteger(maxPayloadSize, 'maxPayloadSize', (candidate) => {
    if (candidate < 1024) {
      return 'maxPayloadSize must be at least 1024';
    }

    if (candidate > bufferMaxBytes) {
      return 'maxPayloadSize must be less than or equal to bufferMaxBytes';
    }

    return null;
  });

  assertPositiveInteger(maxConcurrentRequests, 'maxConcurrentRequests');
  assertPositiveInteger(rateLimitPerMinute, 'rateLimitPerMinute');
  assertPositiveInteger(
    maxLocalsCollectionsPerSecond,
    'maxLocalsCollectionsPerSecond'
  );
  assertPositiveInteger(maxCachedLocals, 'maxCachedLocals');
  assertPositiveInteger(maxLocalsFrames, 'maxLocalsFrames');
  assertPositiveInteger(
    uncaughtExceptionExitDelayMs,
    'uncaughtExceptionExitDelayMs'
  );

  if (transport.type === 'http') {
    throw new Error(
      'HTTP transport is not supported in local-only mode. Use "stdout" or "file" transport.'
    );
  }

  return {
    bufferSize,
    bufferMaxBytes,
    maxPayloadSize,
    maxConcurrentRequests,
    rateLimitPerMinute,
    headerAllowlist: [...(userConfig.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST)],
    headerBlocklist: [...(userConfig.headerBlocklist ?? DEFAULT_HEADER_BLOCKLIST)],
    envAllowlist: [...(userConfig.envAllowlist ?? DEFAULT_ENV_ALLOWLIST)],
    envBlocklist: [...(userConfig.envBlocklist ?? DEFAULT_ENV_BLOCKLIST)],
    encryptionKey: userConfig.encryptionKey,
    allowUnencrypted: userConfig.allowUnencrypted ?? false,
    transport,
    captureLocalVariables: userConfig.captureLocalVariables ?? false,
    captureDbBindParams: userConfig.captureDbBindParams ?? false,
    captureBody: userConfig.captureBody ?? true,
    captureBodyDigest: userConfig.captureBodyDigest ?? false,
    bodyCaptureContentTypes: [
      ...(userConfig.bodyCaptureContentTypes ?? DEFAULT_BODY_CAPTURE_CONTENT_TYPES)
    ],
    piiScrubber: userConfig.piiScrubber,
    replaceDefaultScrubber: userConfig.replaceDefaultScrubber ?? false,
    serialization: resolveSerializationLimits(userConfig),
    maxLocalsCollectionsPerSecond,
    maxCachedLocals,
    maxLocalsFrames,
    uncaughtExceptionExitDelayMs,
    allowInsecureTransport: userConfig.allowInsecureTransport ?? false
  };
}
