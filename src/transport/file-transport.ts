/**
 * @module 14-transport
 * @spec spec/14-transport.md
 * @dependencies types.ts, config.ts, encryption.ts
 */

import fs = require('node:fs');

interface FileTransportConfig {
  path: string;
  maxSizeBytes?: number;
}

export class FileTransport {
  private readonly path: string;

  private readonly maxSizeBytes: number;

  public constructor(config: FileTransportConfig) {
    this.path = config.path;
    this.maxSizeBytes = config.maxSizeBytes ?? 100 * 1024 * 1024;
  }

  public async send(payload: string | Buffer): Promise<void> {
    try {
      await this.rotateIfNeeded();
      const line = Buffer.isBuffer(payload)
        ? Buffer.concat([payload, Buffer.from('\n')])
        : `${payload}\n`;

      await new Promise<void>((resolve, reject) => {
        fs.appendFile(this.path, line, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] File transport dropped payload: ${message}`);
    }
  }

  public async flush(): Promise<void> {
    return Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public sendSync(payload: string): void {
    try {
      fs.writeFileSync(this.path, `${payload}\n`, { flag: 'a' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ECD] File transport sync write failed: ${message}`);
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    const stats = await new Promise<fs.Stats | null>((resolve) => {
      fs.stat(this.path, (error, value) => {
        if (error) {
          resolve(null);
          return;
        }

        resolve(value);
      });
    });

    if (stats === null || stats.size <= this.maxSizeBytes) {
      return;
    }

    const rotatedPath = `${this.path}.${Date.now()}.bak`;

    await new Promise<void>((resolve, reject) => {
      fs.rename(this.path, rotatedPath, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
