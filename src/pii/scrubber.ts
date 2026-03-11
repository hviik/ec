/**
 * @module 04-pii-scrubbing
 * @spec spec/04-pii-scrubbing.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts
 */

import { homedir } from 'node:os';

import { STANDARD_LIMITS, cloneAndLimit } from '../serialization/clone-and-limit';
import type { ResolvedConfig } from '../types';
import {
  BEARER_REGEX,
  CREDIT_CARD_REGEX,
  EMAIL_REGEX,
  JWT_REGEX,
  SENSITIVE_KEY_REGEX,
  SSN_REGEX,
  isValidLuhn
} from './patterns';

const REDACTED = '[REDACTED]';
const DEPTH_LIMIT = '[DEPTH_LIMIT]';

function cloneRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

function replacePattern(value: string, pattern: RegExp): string {
  return value.replace(cloneRegex(pattern), REDACTED);
}

function replaceCreditCards(value: string): string {
  return value.replace(cloneRegex(CREDIT_CARD_REGEX), (match) =>
    isValidLuhn(match) ? REDACTED : match
  );
}

function matchesRegex(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export class Scrubber {
  private readonly config: ResolvedConfig;

  private readonly homeDirectory: string;

  public constructor(config: ResolvedConfig) {
    this.config = config;
    this.homeDirectory = homedir();
  }

  public scrubObject(obj: object): object {
    try {
      const cloned = cloneAndLimit(obj, STANDARD_LIMITS);
      return this.scrubValue('', cloned) as object;
    } catch {
      return {} as object;
    }
  }

  public scrubValue(key: string, value: unknown): unknown {
    try {
      if (this.config.piiScrubber === undefined) {
        return this.applyDefaultScrubber(key, value, 0, new WeakSet<object>());
      }

      if (this.config.replaceDefaultScrubber) {
        return this.applyCustomScrubber(key, value, () =>
          this.applyDefaultScrubber(key, value, 0, new WeakSet<object>())
        );
      }

      const defaultScrubbed = this.applyDefaultScrubber(
        key,
        value,
        0,
        new WeakSet<object>()
      );

      return this.applyCustomScrubber(key, defaultScrubbed, () => defaultScrubbed);
    } catch {
      return REDACTED;
    }
  }

  public scrubDbParams(params: unknown[]): string[] {
    try {
      return params.map((_, index) => `[PARAM_${index + 1}]`);
    } catch {
      return [];
    }
  }

  public scrubFilePath(path: string): string {
    try {
      const isExactMatch = path === this.homeDirectory;
      const hasPathPrefix =
        path.startsWith(`${this.homeDirectory}/`) ||
        path.startsWith(`${this.homeDirectory}\\`);

      if (!isExactMatch && !hasPathPrefix) {
        return path;
      }

      const suffix = path.slice(this.homeDirectory.length).replace(/^[/\\]/, '');
      return suffix.length === 0 ? '/~/' : `/~/${suffix}`;
    } catch {
      return path;
    }
  }

  public scrubEnv(env: Record<string, string>): Record<string, string> {
    const scrubbed: Record<string, string> = {};

    try {
      for (const [key, value] of Object.entries(env)) {
        const allowed = this.config.envAllowlist.includes(key);
        const blocked = this.config.envBlocklist.some((pattern) =>
          matchesRegex(pattern, key)
        );

        if (allowed && !blocked) {
          scrubbed[key] = String(this.scrubValue(key, value));
        }
      }
    } catch {
      return scrubbed;
    }

    return scrubbed;
  }

  private applyCustomScrubber(
    key: string,
    value: unknown,
    getFallback: () => unknown
  ): unknown {
    try {
      return this.config.piiScrubber?.(key, value) ?? value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] Custom PII scrubber failed: ${message}`);
      return getFallback();
    }
  }

  private applyDefaultScrubber(
    key: string,
    value: unknown,
    depth: number,
    visited: WeakSet<object>
  ): unknown {
    try {
      return this.scrubRecursive(key, value, depth, visited);
    } catch {
      return REDACTED;
    }
  }

  private scrubRecursive(
    key: string,
    value: unknown,
    depth: number,
    visited: WeakSet<object>
  ): unknown {
    if (depth > 10) {
      return DEPTH_LIMIT;
    }

    if (SENSITIVE_KEY_REGEX.test(key)) {
      return REDACTED;
    }

    if (typeof value === 'string') {
      return this.scrubString(value);
    }

    if (value === null || value === undefined) {
      return value ?? null;
    }

    if (Array.isArray(value)) {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);

      return value.map((entry, index) =>
        this.applyDefaultScrubber(String(index), entry, depth + 1, visited)
      );
    }

    if (typeof value === 'object') {
      if (visited.has(value)) {
        return '[Circular]';
      }

      visited.add(value);

      const scrubbed: Record<string, unknown> = {};

      for (const objectKey of Object.keys(value)) {
        try {
          scrubbed[objectKey] = this.applyDefaultScrubber(
            objectKey,
            (value as Record<string, unknown>)[objectKey],
            depth + 1,
            visited
          );
        } catch {
          scrubbed[objectKey] = REDACTED;
        }
      }

      return scrubbed;
    }

    return value;
  }

  private scrubString(value: string): string {
    let scrubbed = value;

    scrubbed = replacePattern(scrubbed, EMAIL_REGEX);
    scrubbed = replaceCreditCards(scrubbed);
    scrubbed = replacePattern(scrubbed, SSN_REGEX);
    scrubbed = replacePattern(scrubbed, JWT_REGEX);
    scrubbed = replacePattern(scrubbed, BEARER_REGEX);

    return scrubbed;
  }
}
