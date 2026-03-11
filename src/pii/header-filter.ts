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

export class HeaderFilter {
  private readonly allowlist: Set<string>;

  private readonly blocklist: RegExp[];

  public constructor(config: ResolvedConfig) {
    this.allowlist = new Set(config.headerAllowlist.map((header) => header.toLowerCase()));
    this.blocklist = config.headerBlocklist;
  }

  public filterHeaders(headers: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {};

    try {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        const normalizedName = headerName.toLowerCase();
        const allowed = this.allowlist.has(normalizedName);
        const blocked = this.blocklist.some((pattern) =>
          matchesRegex(pattern, normalizedName)
        );

        if (allowed && !blocked) {
          filtered[normalizedName] = headerValue;
        }
      }
    } catch {
      return filtered;
    }

    return filtered;
  }
}
