/**
 * @module 13-error-capture-pipeline
 * @spec spec/13-error-capture-pipeline.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts, io-event-buffer.ts, scrubber.ts,
 *               encryption.ts, rate-limiter.ts, als-manager.ts, request-tracker.ts, inspector-manager.ts
 */

import fs = require('node:fs');
import * as path from 'node:path';

import type { ProcessMetadata as ProcessMetadataShape, ResolvedConfig } from '../types';

interface StartupMetadata {
  nodeVersion: string;
  v8Version: string;
  platform: string;
  arch: string;
  pid: number;
}

interface RuntimeMetadata {
  uptime: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  activeHandles: number;
  activeRequests: number;
  eventLoopLagMs: number;
}

export class ProcessMetadata {
  private readonly config: ResolvedConfig;

  private startupMetadata: StartupMetadata | null = null;

  private codeVersion: { gitSha?: string; packageVersion?: string } = {};

  private environment: Record<string, string> = {};

  private eventLoopLagMs = 0;

  private lagTimer: NodeJS.Timeout | null = null;

  public constructor(config: ResolvedConfig) {
    this.config = config;
    this.collectStartupMetadata();
  }

  public collectStartupMetadata(): void {
    this.startupMetadata = {
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid
    };
    this.codeVersion = {
      gitSha:
        process.env.GIT_SHA ??
        process.env.COMMIT_SHA ??
        process.env.SOURCE_VERSION ??
        this.readGitHead(),
      packageVersion: process.env.npm_package_version
    };
    this.environment = this.filterEnvironment(process.env as Record<string, string | undefined>);
  }

  public getStartupMetadata(): StartupMetadata {
    if (this.startupMetadata === null) {
      this.collectStartupMetadata();
    }

    return { ...(this.startupMetadata as StartupMetadata) };
  }

  public getRuntimeMetadata(): RuntimeMetadata {
    const memoryUsage = process.memoryUsage();

    return {
      uptime: process.uptime(),
      memoryUsage: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers
      },
      activeHandles: this.getActiveCount('_getActiveHandles'),
      activeRequests: this.getActiveCount('_getActiveRequests'),
      eventLoopLagMs: this.getEventLoopLag()
    };
  }

  public getEventLoopLag(): number {
    return this.eventLoopLagMs;
  }

  public startEventLoopLagMeasurement(): void {
    if (this.lagTimer !== null) {
      return;
    }

    const schedule = () => {
      const scheduledAt = Date.now();

      this.lagTimer = setTimeout(() => {
        this.eventLoopLagMs = Math.max(0, Date.now() - scheduledAt);
        this.lagTimer = null;
        schedule();
      }, 0);
      this.lagTimer.unref();
    };

    schedule();
  }

  public getCodeVersion(): { gitSha?: string; packageVersion?: string } {
    return { ...this.codeVersion };
  }

  public getEnvironment(): Record<string, string> {
    return { ...this.environment };
  }

  public getMergedMetadata(): ProcessMetadataShape {
    return {
      ...this.getStartupMetadata(),
      ...this.getRuntimeMetadata()
    };
  }

  public shutdown(): void {
    if (this.lagTimer !== null) {
      clearTimeout(this.lagTimer);
      this.lagTimer = null;
    }
  }

  private filterEnvironment(
    env: Record<string, string | undefined>
  ): Record<string, string> {
    const filtered: Record<string, string> = {};

    for (const key of this.config.envAllowlist) {
      const value = env[key];
      const blocked = this.config.envBlocklist.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(key);
      });

      if (!blocked && typeof value === 'string') {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  private readGitHead(): string | undefined {
    try {
      const gitDir = path.join(process.cwd(), '.git');
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();

      if (!head.startsWith('ref: ')) {
        return head || undefined;
      }

      const refPath = head.slice(5);
      const refValue = fs.readFileSync(path.join(gitDir, refPath), 'utf8').trim();

      return refValue || undefined;
    } catch {
      return undefined;
    }
  }

  private getActiveCount(methodName: '_getActiveHandles' | '_getActiveRequests'): number {
    try {
      const processWithInternals = process as typeof process & {
        _getActiveHandles?: () => unknown[];
        _getActiveRequests?: () => unknown[];
      };
      const method = processWithInternals[methodName];

      if (typeof method !== 'function') {
        return -1;
      }

      return method().length;
    } catch {
      return -1;
    }
  }
}
