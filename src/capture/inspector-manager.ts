/**
 * @module 12-v8-inspector
 * @spec spec/12-v8-inspector.md
 * @dependencies types.ts, config.ts
 */

import type { CapturedFrame, ResolvedConfig } from '../types';

const SENSITIVE_VAR_RE =
  /^(password|secret|token|apiKey|privateKey|credential|auth|sessionId)$/i;
const STRING_LIMIT = 2048;
const CACHE_TTL_MS = 30000;

interface InspectorModule {
  url(): string | undefined;
  Session: new () => InspectorSession;
}

interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    callback: (error?: Error | null, result?: unknown) => void
  ): void;
  post(
    method: string,
    params: Record<string, unknown>,
    callback: (error?: Error | null, result?: unknown) => void
  ): void;
  on(event: 'Debugger.paused', handler: (event: { params: PausedEventParams }) => void): void;
}

interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}

interface Scope {
  type: string;
  object: RemoteObject;
}

interface CallFrame {
  functionName: string;
  location: {
    lineNumber: number;
    columnNumber: number;
  };
  url?: string;
  scopeChain: Scope[];
}

interface PausedEventParams {
  reason: string;
  data?: RemoteObject;
  callFrames: CallFrame[];
}

function getInspectorModule(): InspectorModule {
  return require('node:inspector') as InspectorModule;
}

function firstLine(value: string | undefined): string {
  return value?.split('\n')[0] ?? '';
}

export class InspectorManager {
  private readonly maxCollectionsPerSecond: number;

  private readonly maxCachedLocals: number;

  private readonly maxLocalsFrames: number;

  private available = false;

  private session: InspectorSession | null = null;

  private readonly cache = new Map<string, { frames: CapturedFrame[]; timestamp: number }>();

  private collectionCountThisSecond = 0;

  private rateLimitTimer: NodeJS.Timeout | null = null;

  private cacheSweepTimer: NodeJS.Timeout | null = null;

  public constructor(config: ResolvedConfig) {
    this.maxCollectionsPerSecond = config.maxLocalsCollectionsPerSecond;
    this.maxCachedLocals = config.maxCachedLocals;
    this.maxLocalsFrames = config.maxLocalsFrames;

    if (!config.captureLocalVariables) {
      return;
    }

    let inspectorModule: InspectorModule;

    try {
      inspectorModule = getInspectorModule();
    } catch {
      return;
    }

    if (inspectorModule.url()) {
      console.warn('[ECD] Debugger already attached; local variable capture disabled');
      return;
    }

    try {
      this.session = new inspectorModule.Session();
      this.session.connect();
      this.session.post('Debugger.enable', () => undefined);
      this.session.post(
        'Debugger.setPauseOnExceptions',
        { state: 'all' },
        () => undefined
      );
      this.session.on('Debugger.paused', (event) => {
        this._onPaused(event.params);
      });
      this.rateLimitTimer = setInterval(() => {
        this.collectionCountThisSecond = 0;
      }, 1000);
      this.rateLimitTimer.unref();
      this.cacheSweepTimer = setInterval(() => {
        this._sweepCache();
      }, 10000);
      this.cacheSweepTimer.unref();
      this.available = true;
    } catch {
      this.available = false;
      this.session = null;
    }
  }

  public getLocals(error: Error): CapturedFrame[] | null {
    const key = `${error.constructor.name}: ${error.message}`;
    const entry = this.cache.get(key);

    if (entry === undefined) {
      return null;
    }

    this.cache.delete(key);
    return entry.frames;
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public shutdown(): void {
    if (this.rateLimitTimer !== null) {
      clearInterval(this.rateLimitTimer);
      this.rateLimitTimer = null;
    }

    if (this.cacheSweepTimer !== null) {
      clearInterval(this.cacheSweepTimer);
      this.cacheSweepTimer = null;
    }

    this.cache.clear();

    if (this.session !== null) {
      try {
        this.session.disconnect();
      } catch {
        // Ignore disconnect failures during teardown.
      }
    }

    this.session = null;
    this.available = false;
  }

  private _onPaused(params: PausedEventParams): void {
    try {
      try {
        if (
          params.reason !== 'exception' &&
          params.reason !== 'promiseRejection'
        ) {
          return;
        }

        if (this.collectionCountThisSecond >= this.maxCollectionsPerSecond) {
          return;
        }

        if (this.cache.size >= this.maxCachedLocals) {
          return;
        }

        const appFrames = params.callFrames
          .filter((frame) => this._isAppFrame(frame.url))
          .slice(0, this.maxLocalsFrames);

        if (appFrames.length === 0) {
          return;
        }

        const collected: CapturedFrame[] = [];

        for (const frame of appFrames) {
          const localScope = frame.scopeChain.find((scope) => scope.type === 'local');

          if (localScope?.object.objectId === undefined || this.session === null) {
            continue;
          }

          this.session.post(
            'Runtime.getProperties',
            {
              objectId: localScope.object.objectId,
              ownProperties: true
            },
            (error, result) => {
              if (error || result === undefined) {
                return;
              }

              const properties = (result as { result?: PropertyDescriptor[] }).result;

              if (properties === undefined) {
                return;
              }

              collected.push({
                functionName: frame.functionName,
                filePath: frame.url ?? '',
                lineNumber: frame.location.lineNumber + 1,
                columnNumber: frame.location.columnNumber + 1,
                locals: this._extractLocals(properties)
              });
            }
          );
        }

        if (collected.length === 0) {
          return;
        }

        const key = this._buildCacheKey(params.data);

        if (key === null) {
          return;
        }

        this.cache.set(key, {
          frames: collected,
          timestamp: Date.now()
        });
        this.collectionCountThisSecond += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ECD] Inspector paused handler failed: ${message}`);
      }
    } finally {
      if (this.session !== null) {
        try {
          this.session.post('Debugger.resume', () => undefined);
        } catch {
          // Resume best-effort only.
        }
      }
    }
  }

  private _extractLocals(properties: PropertyDescriptor[]): Record<string, unknown> {
    const locals: Record<string, unknown> = {};

    for (const property of properties) {
      if (SENSITIVE_VAR_RE.test(property.name)) {
        locals[property.name] = '[REDACTED]';
        continue;
      }

      locals[property.name] = this._serializeRemoteObject(property.value);
    }

    return locals;
  }

  private _serializeRemoteObject(object: RemoteObject | undefined): unknown {
    if (object === undefined) {
      return undefined;
    }

    if (object.subtype === 'null') {
      return null;
    }

    if (object.type === 'undefined') {
      return undefined;
    }

    if (object.type === 'string') {
      const value = typeof object.value === 'string' ? object.value : '';
      return value.length > STRING_LIMIT
        ? `${value.slice(0, STRING_LIMIT)}...[truncated, ${value.length} chars]`
        : value;
    }

    if (object.type === 'number' || object.type === 'boolean') {
      return object.value;
    }

    if (object.type === 'bigint') {
      return {
        _type: 'BigInt',
        value: object.description
      };
    }

    if (object.type === 'symbol') {
      return {
        _type: 'Symbol',
        description: object.description
      };
    }

    if (object.type === 'function') {
      return `[Function: ${object.description ?? 'anonymous'}]`;
    }

    if (object.subtype === 'array') {
      return `[Array(${object.description ?? ''})]`;
    }

    if (object.subtype === 'regexp' || object.subtype === 'date' || object.subtype === 'error') {
      return object.description;
    }

    if (object.subtype === 'map') {
      return `[Map(${object.description ?? ''})]`;
    }

    if (object.subtype === 'set') {
      return `[Set(${object.description ?? ''})]`;
    }

    return `[${object.className ?? 'Object'}]`;
  }

  private _buildCacheKey(data: RemoteObject | undefined): string | null {
    if (data === undefined) {
      return null;
    }

    if (typeof data.className === 'string') {
      const line = firstLine(data.description);

      return line.startsWith(`${data.className}: `)
        ? line
        : `${data.className}: ${line}`;
    }

    if (data.value !== undefined) {
      return String(data.value);
    }

    if (typeof data.description === 'string') {
      return data.description;
    }

    return null;
  }

  private _isAppFrame(url: string | undefined): boolean {
    if (url === undefined || url === '') {
      return false;
    }

    const normalizedUrl = url.replace(/\\/g, '/');

    return !(
      normalizedUrl.startsWith('node:') ||
      normalizedUrl.includes('/node_modules/') ||
      normalizedUrl.includes('node:internal') ||
      normalizedUrl.includes('/src/capture/inspector-manager') ||
      normalizedUrl.includes('/dist/capture/inspector-manager')
    );
  }

  private _sweepCache(): void {
    const cutoff = Date.now() - CACHE_TTL_MS;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < cutoff) {
        this.cache.delete(key);
      }
    }
  }
}
