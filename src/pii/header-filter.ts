/**
 * @module 04-pii-scrubbing
 * @spec spec/04-pii-scrubbing.md
 * @dependencies types.ts, config.ts, clone-and-limit.ts
 */

import type { ResolvedConfig } from '../types';

function matchesRegex(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function normalizeHeaderValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    let joined = '';

    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue;
      }

      joined = joined === '' ? entry : `${joined}, ${entry}`;
    }

    return joined;
  }

  return null;
}

export class HeaderFilter {
  private readonly allowlist: Set<string>;

  private readonly blocklist: RegExp[];

  public constructor(config: ResolvedConfig) {
    this.allowlist = new Set(config.headerAllowlist.map((header) => header.toLowerCase()));
    this.blocklist = config.headerBlocklist;
  }

  public filterHeaders(headers: Record<string, unknown>): Record<string, string> {
    const filtered: Record<string, string> = {};

    try {
      for (const headerName in headers) {
        const headerValue = headers[headerName];
        const normalizedName = headerName.toLowerCase();
        const normalizedValue = normalizeHeaderValue(headerValue);

        if (normalizedValue === null || !this.allowlist.has(normalizedName)) {
          continue;
        }

        if (this.blocklist.some((pattern) => matchesRegex(pattern, normalizedName))) {
          continue;
        }

        filtered[normalizedName] = normalizedValue;
      }
    } catch {
      return filtered;
    }

    return filtered;
  }
}
