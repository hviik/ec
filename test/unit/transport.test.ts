import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config';
import { ECD_INTERNAL, SDK_INTERNAL_REQUESTS } from '../../src/recording/http-client';
import { isInternalCallActive } from '../../src/recording/internal';
import { HttpTransport } from '../../src/transport/http-transport';
import { FileTransport } from '../../src/transport/file-transport';
import { StdoutTransport } from '../../src/transport/stdout-transport';
import { TransportDispatcher } from '../../src/transport/transport';

const nodeRequire = createRequire(import.meta.url);
const Module = nodeRequire('node:module') as typeof import('node:module');
const fs = nodeRequire('node:fs') as typeof import('node:fs');
const path = nodeRequire('node:path') as typeof import('node:path');
const os = nodeRequire('node:os') as typeof import('node:os');
const httpsModule = nodeRequire('node:https') as typeof import('node:https');
const httpModule = nodeRequire('node:http') as typeof import('node:http');
const originalRequire = Module.prototype.require;

class MockWorker extends EventEmitter {
  public readonly postMessage = vi.fn((message: { id: number; type: string }) => {
    this.emit('message', { id: message.id });
  });

  public readonly terminate = vi.fn(async () => 1);
}

function withWorkerThreadsMock<T>(
  workerFactory: () => MockWorker,
  run: () => Promise<T> | T
): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:worker_threads') {
      return {
        Worker: class {
          public constructor() {
            return workerFactory();
          }
        }
      };
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function withMissingWorkerThreads<T>(run: () => Promise<T> | T): Promise<T> | T {
  Module.prototype.require = function patchedRequire(this: NodeJS.Module, request: string) {
    if (request === 'node:worker_threads') {
      throw new Error('worker_threads unavailable');
    }

    return originalRequire.apply(this, [request]);
  };

  return run();
}

function createMockRequest(options: {
  statuses: number[];
  timeoutBehavior?: 'trigger' | 'none';
}) {
  const response = new EventEmitter() as EventEmitter & { statusCode?: number };
  let callCount = 0;

  return vi.fn((requestOptions: unknown, callback: (response: typeof response) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };

    request.write = vi.fn();
    request.destroy = vi.fn((error?: Error) => {
      if (error !== undefined) {
        request.emit('error', error);
      }
    });
    request.setTimeout = vi.fn((_: number, handler: () => void) => {
      if (options.timeoutBehavior === 'trigger') {
        handler();
      }
      return request;
    });
    request.end = vi.fn(() => {
      response.statusCode = options.statuses[Math.min(callCount, options.statuses.length - 1)];
      callCount += 1;
      callback(response);
      response.emit('data', Buffer.from('ok'));
      response.emit('end');
    });

    return request;
  });
}

describe('HttpTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('sends payloads with the correct HTTPS headers', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect',
      apiKey: 'secret-key'
    });

    await transport.send('{"ok":true}');

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy.mock.calls[0]?.[0]).toMatchObject({
      protocol: 'https:',
      hostname: 'example.com',
      path: '/collect',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer secret-key'
      }
    });
  });

  it('marks HTTP transport requests as SDK-internal during creation', async () => {
    const requestSpy = vi.fn((requestOptions: unknown, callback: (response: EventEmitter) => void) => {
      expect(isInternalCallActive()).toBe(true);

      const response = new EventEmitter() as EventEmitter & { statusCode?: number };
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
        [ECD_INTERNAL]?: boolean;
      };

      request.write = vi.fn();
      request.destroy = vi.fn();
      request.setTimeout = vi.fn(() => request);
      request.end = vi.fn(() => {
        response.statusCode = 200;
        callback(response);
        response.emit('end');
      });

      void requestOptions;
      return request;
    });
    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect'
    });

    await transport.send('payload');

    const request = requestSpy.mock.results[0]?.value as { [ECD_INTERNAL]?: boolean };

    expect(request[ECD_INTERNAL]).toBe(true);
    expect(SDK_INTERNAL_REQUESTS.has(request as object)).toBe(true);
  });

  it('retries on failure and succeeds on a later attempt', async () => {
    const requestSpy = createMockRequest({ statuses: [500, 500, 200] });
    const delaySpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      fn();
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect'
    });

    await transport.send('payload');

    expect(requestSpy).toHaveBeenCalledTimes(3);
    expect(delaySpy).toHaveBeenCalled();
  });

  it('handles request timeouts', async () => {
    const requestSpy = createMockRequest({ statuses: [200], timeoutBehavior: 'trigger' });

    httpsModule.request = requestSpy as typeof httpsModule.request;

    const transport = new HttpTransport({
      url: 'https://example.com/collect',
      retries: 1
    });

    await transport.send('payload');

    const request = requestSpy.mock.results[0]?.value as { destroy: ReturnType<typeof vi.fn> };

    expect(request.destroy).toHaveBeenCalled();
  });

  it('rejects insecure HTTP URLs by default', () => {
    expect(
      () =>
        new HttpTransport({
          url: 'http://example.com/collect'
        })
    ).toThrow('HTTP transport requires HTTPS unless allowInsecureTransport is true');
  });

  it('allows insecure HTTP when explicitly enabled', async () => {
    const requestSpy = createMockRequest({ statuses: [200] });
    httpModule.request = requestSpy as typeof httpModule.request;

    const transport = new HttpTransport({
      url: 'http://example.com/collect',
      allowInsecureTransport: true
    });

    await transport.send('payload');

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FileTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('appends JSON lines to a file', async () => {
    const filePath = path.join(os.tmpdir(), `ecd-transport-${Date.now()}.log`);
    const transport = new FileTransport({ path: filePath });

    await transport.send('{"a":1}');
    await transport.send('{"b":2}');

    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toBe('{"a":1}\n{"b":2}\n');
    fs.rmSync(filePath, { force: true });
  });

  it('rotates the file when it exceeds the size limit', async () => {
    const filePath = path.join(os.tmpdir(), `ecd-rotate-${Date.now()}.log`);

    fs.writeFileSync(filePath, 'x'.repeat(32));

    const transport = new FileTransport({ path: filePath, maxSizeBytes: 8 });

    await transport.send('payload');

    const files = fs
      .readdirSync(path.dirname(filePath))
      .filter((entry) => entry.startsWith(path.basename(filePath)));

    expect(files.some((entry) => entry.endsWith('.bak'))).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('payload\n');

    for (const file of files) {
      fs.rmSync(path.join(path.dirname(filePath), file), { force: true });
    }
  });

  it('sendSync writes synchronously', () => {
    const filePath = path.join(os.tmpdir(), `ecd-sync-${Date.now()}.log`);
    const transport = new FileTransport({ path: filePath });

    transport.sendSync('sync-payload');

    expect(fs.readFileSync(filePath, 'utf8')).toBe('sync-payload\n');
    fs.rmSync(filePath, { force: true });
  });
});

describe('StdoutTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('writes payloads to stdout and sendSync to stdout synchronously', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);
    const writeSync = vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    const transport = new StdoutTransport();

    await transport.send('payload');
    transport.sendSync('sync-payload');

    expect(stdoutWrite).toHaveBeenCalled();
    expect(writeSync).toHaveBeenCalledWith(1, 'sync-payload\n');
  });
});

describe('TransportDispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Module.prototype.require = originalRequire;
  });

  it('uses worker send/flush/shutdown lifecycle when worker creation succeeds', async () => {
    const worker = new MockWorker();

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveConfig({}),
        encryption: null
      });

      await dispatcher.send('payload');
      await dispatcher.flush();
      await dispatcher.shutdown();
    });

    expect(worker.postMessage).toHaveBeenCalledTimes(3);
    expect(worker.postMessage.mock.calls.map((call) => call[0].type)).toEqual([
      'send',
      'flush',
      'shutdown'
    ]);
  });

  it('falls back to main-thread dispatch when worker threads are unavailable', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);

    await withMissingWorkerThreads(async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveConfig({ transport: { type: 'stdout' } }),
        encryption: null
      });

      await dispatcher.send('payload');
      await dispatcher.flush();
    });

    expect(stdoutWrite).toHaveBeenCalled();
  });

  it('forces worker termination on shutdown timeout', async () => {
    class HangingWorker extends MockWorker {
      public override postMessage = vi.fn();
    }

    const worker = new HangingWorker();
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: TimerHandler) => {
        fn();
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveConfig({}),
        encryption: null
      });

      await dispatcher.shutdown({ timeoutMs: 1 });
    });

    expect(timeoutSpy).toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('falls back to main-thread dispatch after a worker error', async () => {
    class ErroringWorker extends MockWorker {
      private sentCount = 0;

      public override postMessage = vi.fn((message: { id: number; type: string }) => {
        this.sentCount += 1;
        this.emit('message', { id: message.id });

        if (this.sentCount === 1) {
          this.emit('error', new Error('worker crashed'));
        }
      });
    }

    const worker = new ErroringWorker();
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);

    await withWorkerThreadsMock(() => worker, async () => {
      const dispatcher = new TransportDispatcher({
        config: resolveConfig({ transport: { type: 'stdout' } }),
        encryption: null
      });

      await dispatcher.send('first');
      await dispatcher.send('second');
      await dispatcher.flush();
    });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).toHaveBeenCalled();
  });
});
