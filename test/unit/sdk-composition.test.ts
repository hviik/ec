import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureError as captureErrorFacade,
  createSDK as createSDKFacade,
  init,
  shutdown as shutdownFacade,
  trackState as trackStateFacade,
  withContext as withContextFacade
} from '../../src/index';
import { createSDK } from '../../src/sdk';

describe('SDK composition', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownFacade();
  });

  it('createSDK returns an SDKInstance with all components wired', async () => {
    const sdk = createSDK();

    try {
      expect(sdk.config).toBeDefined();
      expect(sdk.buffer).toBeDefined();
      expect(sdk.als).toBeDefined();
      expect(sdk.requestTracker).toBeDefined();
      expect(sdk.inspector).toBeDefined();
      expect(sdk.channelSubscriber).toBeDefined();
      expect(sdk.patchManager).toBeDefined();
      expect(sdk.stateTracker).toBeDefined();
      expect(sdk.errorCapturer).toBeDefined();
      expect(sdk.transport).toBeDefined();
      expect(sdk.processMetadata).toBeDefined();
    } finally {
      await sdk.shutdown();
    }
  });

  it('activate subscribes channels, installs patches, registers handlers, and starts lag measurement', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const sdk = createSDK();
    const collectSpy = vi.spyOn(sdk.processMetadata, 'collectStartupMetadata');
    const lagSpy = vi.spyOn(sdk.processMetadata, 'startEventLoopLagMeasurement');
    const subscribeSpy = vi.spyOn(sdk.channelSubscriber, 'subscribeAll');
    const patchSpy = vi.spyOn(sdk.patchManager, 'installAll');

    try {
      sdk.activate();

      expect(sdk.isActive()).toBe(true);
      expect(collectSpy).toHaveBeenCalledTimes(1);
      expect(subscribeSpy).toHaveBeenCalledTimes(1);
      expect(patchSpy).toHaveBeenCalledTimes(1);
      expect(lagSpy).toHaveBeenCalledTimes(1);
      expect(onSpy.mock.calls.map((call) => call[0])).toEqual(
        expect.arrayContaining([
          'uncaughtException',
          'unhandledRejection',
          'beforeExit',
          'exit'
        ])
      );
    } finally {
      await sdk.shutdown();
    }
  });

  it('captureError delegates only when active', async () => {
    const sdk = createSDK();
    const captureSpy = vi.spyOn(sdk.errorCapturer, 'capture').mockReturnValue(null);

    try {
      sdk.captureError(new Error('inactive'));
      expect(captureSpy).not.toHaveBeenCalled();

      sdk.activate();
      sdk.captureError(new Error('active'));

      expect(captureSpy).toHaveBeenCalledTimes(1);
    } finally {
      await sdk.shutdown();
    }
  });

  it('shutdown is idempotent and tears down components in order', async () => {
    const removeListenerSpy = vi.spyOn(process, 'removeListener');
    const sdk = createSDK();
    const unsubscribeSpy = vi.spyOn(sdk.channelSubscriber, 'unsubscribeAll');
    const unwrapSpy = vi.spyOn(sdk.patchManager, 'unwrapAll');
    const inspectorSpy = vi.spyOn(sdk.inspector, 'shutdown');
    const flushSpy = vi.spyOn(sdk.transport, 'flush');
    const transportShutdownSpy = vi.spyOn(sdk.transport, 'shutdown');
    const clearSpy = vi.spyOn(sdk.buffer, 'clear');

    sdk.activate();
    unsubscribeSpy.mockClear();
    unwrapSpy.mockClear();
    inspectorSpy.mockClear();
    flushSpy.mockClear();
    transportShutdownSpy.mockClear();
    clearSpy.mockClear();

    await sdk.shutdown();
    await sdk.shutdown();

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(unwrapSpy).toHaveBeenCalledTimes(1);
    expect(inspectorSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(transportShutdownSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(removeListenerSpy).toHaveBeenCalled();
    expect(sdk.isActive()).toBe(false);
  });

  it('init twice throws and shutdown then init again works', async () => {
    const first = init({ transport: { type: 'stdout' } });

    expect(() => init()).toThrow('SDK already initialized. Call shutdown() first.');

    await shutdownFacade();

    const second = init({ transport: { type: 'stdout' } });

    expect(first).not.toBe(second);
    await shutdownFacade();
  });

  it('enableAutoShutdown registers signal handlers', async () => {
    const onceSpy = vi.spyOn(process, 'once');
    const sdk = createSDK();

    try {
      sdk.enableAutoShutdown();

      expect(onceSpy.mock.calls.map((call) => call[0])).toEqual(
        expect.arrayContaining(['SIGTERM', 'SIGINT'])
      );
    } finally {
      await sdk.shutdown();
    }
  });

  it('trackState facade requires initialization and withContext facade passes through when absent', async () => {
    expect(() => trackStateFacade('cache', new Map())).toThrow('SDK is not initialized');
    expect(withContextFacade(() => 'value')).toBe('value');

    const sdk = init({ transport: { type: 'stdout' } });

    try {
      const tracked = trackStateFacade('cache', new Map([['a', 1]]));
      const result = withContextFacade(() => tracked.get('a'));

      expect(result).toBe(1);
      expect(sdk.isActive()).toBe(true);
    } finally {
      await shutdownFacade();
    }
  });

  it('supports a full init -> capture -> shutdown cycle through the public API', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(null);
        return true;
      }) as typeof process.stdout.write);

    const sdk = init({
      transport: { type: 'stdout' }
    });

    try {
      const captureSpy = vi.spyOn(sdk.errorCapturer, 'capture');

      captureErrorFacade(new Error('integration-boom'));

      expect(captureSpy).toHaveBeenCalledTimes(1);
    } finally {
      await shutdownFacade();
    }

    expect(stdoutWrite).toHaveBeenCalled();
    expect(createSDKFacade).toBeDefined();
  });
});
