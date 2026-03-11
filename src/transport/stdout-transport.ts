/**
 * @module 14-transport
 * @spec spec/14-transport.md
 * @dependencies types.ts, config.ts, encryption.ts
 */

export class StdoutTransport {
  public async send(payload: string | Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(
        Buffer.isBuffer(payload) ? Buffer.concat([payload, Buffer.from('\n')]) : `${payload}\n`,
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );
    });
  }

  public async flush(): Promise<void> {
    return Promise.resolve();
  }

  public async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  public sendSync(payload: string): void {
    process.stderr.write(`${payload}\n`);
  }
}
