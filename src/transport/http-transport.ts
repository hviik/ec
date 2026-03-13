/**
 * @module 14-transport
 * @spec spec/14-transport.md
 * @dependencies types.ts, config.ts, encryption.ts
 */

import http = require('node:http');
import https = require('node:https');

import { markRequestAsInternal } from '../recording/internal';
import { runAsInternal } from '../recording/net-dns';

interface HttpTransportConfig {
  url: string;
  apiKey?: string;
  timeoutMs?: number;
  retries?: number;
  allowInsecureTransport?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class HttpTransport {
  private readonly url: URL;

  private readonly apiKey: string | undefined;

  private readonly timeoutMs: number;

  private readonly retries: number;

  private readonly allowInsecureTransport: boolean;

  public constructor(config: HttpTransportConfig) {
    this.url = new URL(config.url);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.retries = config.retries ?? 3;
    this.allowInsecureTransport = config.allowInsecureTransport ?? false;

    if (this.url.protocol !== 'https:' && !this.allowInsecureTransport) {
      throw new Error('HTTP transport requires HTTPS unless allowInsecureTransport is true');
    }
  }

  public async send(payload: string | Buffer): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.retries; attempt += 1) {
      try {
        await this.sendOnce(payload);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.retries - 1) {
          await delay(1000 * 2 ** attempt);
        }
      }
    }

    if (lastError !== null) {
      console.warn(`[ECD] HTTP transport dropped payload: ${lastError.message}`);
    }
  }

  public async flush(): Promise<void> {
    return Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private sendOnce(payload: string | Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const requestModule =
        this.url.protocol === 'https:' ? https : this.allowInsecureTransport ? http : null;

      if (requestModule === null) {
        reject(new Error('HTTP transport requires HTTPS unless allowInsecureTransport is true'));
        return;
      }

      runAsInternal(() => {
        const request = markRequestAsInternal(
          requestModule.request(
            {
              protocol: this.url.protocol,
              hostname: this.url.hostname,
              port: this.url.port === '' ? undefined : Number(this.url.port),
              path: `${this.url.pathname}${this.url.search}`,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': String(body.length),
                ...(this.apiKey === undefined
                  ? {}
                  : { Authorization: `Bearer ${this.apiKey}` })
              }
            },
            (response) => {
              const statusCode = response.statusCode ?? 500;

              response.on('data', () => undefined);
              response.on('end', () => {
                if (statusCode >= 200 && statusCode < 300) {
                  resolve();
                  return;
                }

                reject(new Error(`HTTP ${statusCode}`));
              });
            }
          )
        );

        request.on('error', (error) => {
          reject(error);
        });

        request.setTimeout(this.timeoutMs, () => {
          request.destroy(new Error('HTTP transport timeout'));
        });

        request.write(body);
        request.end();
      });
    });
  }
}
