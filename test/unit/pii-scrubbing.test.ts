import { homedir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config';
import { HeaderFilter } from '../../src/pii/header-filter';
import { Scrubber } from '../../src/pii/scrubber';
import { isValidLuhn } from '../../src/pii/patterns';

function createDepthFixture(depth: number): Record<string, unknown> {
  let current: Record<string, unknown> = { value: 'leaf' };

  for (let index = 0; index < depth; index += 1) {
    current = { child: current };
  }

  return current;
}

describe('Scrubber', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts all documented sensitive keys', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    for (const key of [
      'password',
      'apiKey',
      'secret_token',
      'auth',
      'credential',
      'cvv',
      'expiry_date'
    ]) {
      expect(scrubber.scrubValue(key, 'visible')).toBe('[REDACTED]');
    }
  });

  it('redacts emails in string values', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubValue('message', 'Contact john@example.com today')).toBe(
      'Contact [REDACTED] today'
    );
  });

  it('redacts only Luhn-valid credit card numbers', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(isValidLuhn('4111111111111111')).toBe(true);
    expect(isValidLuhn('4111111111111112')).toBe(false);
    expect(
      scrubber.scrubValue('message', 'Card 4111111111111111 was charged')
    ).toBe('Card [REDACTED] was charged');
    expect(
      scrubber.scrubValue('message', 'Card 4111111111111112 was charged')
    ).toBe('Card 4111111111111112 was charged');
  });

  it('redacts SSNs, JWTs, and bearer tokens', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubValue('message', 'SSN 123-45-6789')).toBe(
      'SSN [REDACTED]'
    );
    expect(
      scrubber.scrubValue(
        'message',
        'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
      )
    ).toBe('JWT [REDACTED]');
    expect(scrubber.scrubValue('authHeader', 'Bearer abc.def/ghi+123=')).toBe(
      '[REDACTED]'
    );
  });

  it('recursively scrubs nested objects', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(
      scrubber.scrubObject({
        profile: {
          email: 'jane@example.com',
          password: 'secret'
        }
      })
    ).toEqual({
      profile: {
        email: '[REDACTED]',
        password: '[REDACTED]'
      }
    });
  });

  it('enforces the scrubber depth limit at level 10', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const output = scrubber.scrubValue('root', createDepthFixture(11)) as {
      child: unknown;
    };

    expect(
      ((((((((((output.child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child as { child: unknown }).child as {
        child: unknown;
      }).child as { child: unknown }).child
    ).toBe('[DEPTH_LIMIT]');
  });

  it('handles circular references without throwing', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const circular: Record<string, unknown> = { name: 'root' };
    circular.self = circular;

    expect(scrubber.scrubValue('root', circular)).toEqual({
      name: 'root',
      self: '[Circular]'
    });
  });

  it('scrubs file paths by replacing the home directory prefix', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const home = homedir();

    expect(scrubber.scrubFilePath(`${home}/app/src/handler.js`)).toBe(
      '/~/app/src/handler.js'
    );
    expect(scrubber.scrubFilePath('/var/app/src/handler.js')).toBe(
      '/var/app/src/handler.js'
    );
  });

  it('returns positional placeholders for database parameters', () => {
    const scrubber = new Scrubber(resolveConfig({}));

    expect(scrubber.scrubDbParams(['secret', 42, null])).toEqual([
      '[PARAM_1]',
      '[PARAM_2]',
      '[PARAM_3]'
    ]);
  });

  it('scrubs environment variables using allowlist and blocklist precedence', () => {
    const scrubber = new Scrubber(
      resolveConfig({
        envAllowlist: ['NODE_ENV', 'API_KEY', 'PUBLIC_EMAIL'],
        envBlocklist: [/KEY/i]
      })
    );

    expect(
      scrubber.scrubEnv({
        NODE_ENV: 'production',
        API_KEY: 'super-secret',
        PUBLIC_EMAIL: 'ops@example.com',
        EXTRA: 'ignored'
      })
    ).toEqual({
      NODE_ENV: 'production',
      PUBLIC_EMAIL: '[REDACTED]'
    });
  });

  it('integrates a custom scrubber after the default scrubber', () => {
    const scrubber = new Scrubber(
      resolveConfig({
        piiScrubber: (_key, value) =>
          typeof value === 'string' ? `${value}::custom` : value
      })
    );

    expect(scrubber.scrubValue('email', 'john@example.com')).toBe(
      '[REDACTED]::custom'
    );
  });

  it('supports custom-only scrubber mode and falls back to default on custom errors', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const customOnly = new Scrubber(
      resolveConfig({
        piiScrubber: () => 'custom-only',
        replaceDefaultScrubber: true
      })
    );
    const throwing = new Scrubber(
      resolveConfig({
        piiScrubber: () => {
          throw new Error('boom');
        },
        replaceDefaultScrubber: true
      })
    );

    expect(customOnly.scrubValue('email', 'john@example.com')).toBe('custom-only');
    expect(throwing.scrubValue('email', 'john@example.com')).toBe('[REDACTED]');
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the input object passed to scrubObject', () => {
    const scrubber = new Scrubber(resolveConfig({}));
    const input = {
      profile: {
        email: 'jane@example.com',
        password: 'secret'
      }
    };
    const snapshot = JSON.stringify(input);

    scrubber.scrubObject(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('HeaderFilter', () => {
  it('filters allowed headers, removes blocked headers, and lets blocklist win', () => {
    const filter = new HeaderFilter(
      resolveConfig({
        headerAllowlist: ['x-request-id', 'authorization', 'user-agent']
      })
    );

    expect(
      filter.filterHeaders({
        'X-Request-ID': 'req-1',
        Authorization: 'Bearer secret',
        'User-Agent': 'curl/8.0',
        Host: 'localhost'
      })
    ).toEqual({
      'x-request-id': 'req-1',
      'user-agent': 'curl/8.0'
    });
  });
});
