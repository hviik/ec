/**
 * @module 14-transport
 * @spec spec/14-transport.md
 * @dependencies types.ts, config.ts, encryption.ts
 */

import type { ResolvedConfig } from '../types';
import type { Encryption } from '../security/encryption';
import { FileTransport } from './file-transport';
import { HttpTransport } from './http-transport';
import { StdoutTransport } from './stdout-transport';

interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface WorkerThreadsModule {
  Worker: new (
    filename: string,
    options: { eval: true; workerData: unknown }
  ) => WorkerLike;
}

interface SyncCapableTransport extends Transport {
  sendSync?(payload: string): void;
}

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface QueueItem {
  payload: string | Buffer;
  resolve: () => void;
}

function getWorkerThreads(): WorkerThreadsModule {
  return require('node:worker_threads') as WorkerThreadsModule;
}

function createWorkerSource(): string {
  return `
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTransport(config) {
  if (config.transport.type === 'stdout') {
    return {
      async send(payload) {
        await new Promise((resolve, reject) => {
          process.stdout.write(
            Buffer.isBuffer(payload) ? Buffer.concat([payload, Buffer.from('\\n')]) : payload + '\\n',
            (error) => error ? reject(error) : resolve()
          );
        });
      },
      async flush() {},
      async shutdown() {}
    };
  }

  if (config.transport.type === 'file') {
    const filePath = config.transport.path;
    const maxSizeBytes = config.transport.maxSizeBytes ?? 100 * 1024 * 1024;

    return {
      async send(payload) {
        const stats = await new Promise((resolve) => {
          fs.stat(filePath, (error, value) => resolve(error ? null : value));
        });

        if (stats && stats.size > maxSizeBytes) {
          await new Promise((resolve, reject) => {
            fs.rename(filePath, filePath + '.' + Date.now() + '.bak', (error) => error ? reject(error) : resolve());
          });
        }

        await new Promise((resolve, reject) => {
          fs.appendFile(
            filePath,
            Buffer.isBuffer(payload) ? Buffer.concat([payload, Buffer.from('\\n')]) : payload + '\\n',
            (error) => error ? reject(error) : resolve()
          );
        });
      },
      async flush() {},
      async shutdown() {}
    };
  }

  const transportUrl = new URL(config.transport.url);
  const timeoutMs = config.transport.timeoutMs ?? 10000;
  const retries = config.transport.retries ?? 3;
  const allowInsecureTransport = config.allowInsecureTransport === true;

  if (transportUrl.protocol !== 'https:' && !allowInsecureTransport) {
    throw new Error('HTTP transport requires HTTPS unless allowInsecureTransport is true');
  }

  async function sendOnce(payload) {
    await new Promise((resolve, reject) => {
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const requestModule = transportUrl.protocol === 'https:' ? https : http;
      const request = requestModule.request(
        {
          protocol: transportUrl.protocol,
          hostname: transportUrl.hostname,
          port: transportUrl.port === '' ? undefined : Number(transportUrl.port),
          path: transportUrl.pathname + transportUrl.search,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(body.length),
            ...(config.transport.apiKey ? { Authorization: 'Bearer ' + config.transport.apiKey } : {})
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

            reject(new Error('HTTP ' + statusCode));
          });
        }
      );

      request.on('error', reject);
      request.setTimeout(timeoutMs, () => request.destroy(new Error('HTTP transport timeout')));
      request.write(body);
      request.end();
    });
  }

  return {
    async send(payload) {
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
          await sendOnce(payload);
          return;
        } catch (error) {
          if (attempt === retries - 1) {
            return;
          }

          await delay(1000 * 2 ** attempt);
        }
      }
    },
    async flush() {},
    async shutdown() {}
  };
}

const transport = createTransport(workerData.config);

parentPort.on('message', async (message) => {
  try {
    if (message.type === 'send') {
      await transport.send(message.payload);
      parentPort.postMessage({ id: message.id });
      return;
    }

    if (message.type === 'flush') {
      await transport.flush();
      parentPort.postMessage({ id: message.id });
      return;
    }

    if (message.type === 'shutdown') {
      await transport.shutdown();
      parentPort.postMessage({ id: message.id });
      process.exit(0);
    }
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;
}

function createTransport(config: ResolvedConfig): SyncCapableTransport {
  if (config.transport.type === 'stdout') {
    return new StdoutTransport();
  }

  if (config.transport.type === 'file') {
    return new FileTransport(config.transport);
  }

  return new HttpTransport({
    ...config.transport,
    allowInsecureTransport: config.allowInsecureTransport
  });
}

export interface Transport {
  send(payload: string | Buffer): Promise<void>;
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

export class TransportDispatcher implements Transport {
  private readonly config: ResolvedConfig;

  private readonly encryption: Encryption | null;

  private worker: WorkerLike | null = null;

  private requestId = 0;

  private readonly pending = new Map<number, PendingRequest>();

  private fallbackTransport: SyncCapableTransport | null = null;

  private fallbackQueue: QueueItem[] = [];

  private fallbackFlushResolvers: Array<() => void> = [];

  private fallbackScheduled = false;

  private shuttingDown = false;

  public constructor(input: { config: ResolvedConfig; encryption: Encryption | null }) {
    this.config = input.config;
    this.encryption = input.encryption;
    this.initializeWorker();
  }

  public async send(payload: string | Buffer): Promise<void> {
    if (this.worker !== null) {
      return this.dispatchToWorker('send', payload);
    }

    return this.enqueueFallback(payload);
  }

  public async flush(): Promise<void> {
    if (this.worker !== null) {
      return this.dispatchToWorker('flush');
    }

    if (!this.fallbackScheduled && this.fallbackQueue.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.fallbackFlushResolvers.push(resolve);
    });
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    this.shuttingDown = true;

    if (this.worker === null) {
      await this.flush();

      if (this.fallbackTransport !== null) {
        await this.fallbackTransport.shutdown(options);
      }

      return;
    }

    const timeoutMs = options?.timeoutMs ?? 5000;

    await Promise.race([
      this.dispatchToWorker('shutdown'),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          void this.worker?.terminate().finally(() => resolve());
        }, timeoutMs);

        timeout.unref();
      })
    ]);
  }

  public sendSync(payload: string): void {
    const transport = this.fallbackTransport ?? createTransport(this.config);

    transport.sendSync?.(payload);
    void this.encryption;
  }

  private initializeWorker(): void {
    try {
      const workerThreads = getWorkerThreads();
      const worker = new workerThreads.Worker(createWorkerSource(), {
        eval: true,
        workerData: {
          config: this.config
        }
      });

      worker.on('message', (message) => {
        const response = message as { id: number; error?: string };
        const pending = this.pending.get(response.id);

        if (pending === undefined) {
          return;
        }

        this.pending.delete(response.id);

        if (response.error !== undefined) {
          pending.reject(new Error(response.error));
          return;
        }

        pending.resolve();
      });

      worker.on('error', () => {
        this.fallbackToMainThread();
      });

      worker.on('exit', (code) => {
        if (!this.shuttingDown && code !== 0) {
          this.fallbackToMainThread();
        }
      });

      this.worker = worker;
    } catch {
      this.fallbackToMainThread();
    }
  }

  private fallbackToMainThread(): void {
    this.worker = null;

    if (this.fallbackTransport === null) {
      this.fallbackTransport = createTransport(this.config);
    }
  }

  private dispatchToWorker(
    type: 'send' | 'flush' | 'shutdown',
    payload?: string | Buffer
  ): Promise<void> {
    if (this.worker === null) {
      return type === 'send' && payload !== undefined
        ? this.enqueueFallback(payload)
        : Promise.resolve();
    }

    const id = ++this.requestId;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ id, type, payload });
    });
  }

  private enqueueFallback(payload: string | Buffer): Promise<void> {
    if (this.fallbackTransport === null) {
      this.fallbackTransport = createTransport(this.config);
    }

    return new Promise<void>((resolve) => {
      this.fallbackQueue.push({ payload, resolve });
      this.scheduleFallbackProcessing();
    });
  }

  private scheduleFallbackProcessing(): void {
    if (this.fallbackScheduled) {
      return;
    }

    this.fallbackScheduled = true;

    setImmediate(() => {
      void this.processFallbackQueue();
    });
  }

  private async processFallbackQueue(): Promise<void> {
    this.fallbackScheduled = false;

    while (this.fallbackQueue.length > 0) {
      const item = this.fallbackQueue.shift();

      if (item === undefined) {
        continue;
      }

      try {
        await this.fallbackTransport?.send(item.payload);
      } finally {
        item.resolve();
      }
    }

    while (this.fallbackFlushResolvers.length > 0) {
      this.fallbackFlushResolvers.shift()?.();
    }
  }
}
