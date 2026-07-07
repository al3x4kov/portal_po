import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerShutdown, type ShutdownApp, type SignalSource } from '../src/lib/shutdown.js';

function fakeApp(close: () => Promise<void>): ShutdownApp & {
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
} {
  return {
    close: vi.fn(close),
    log: { info: vi.fn(), error: vi.fn() },
  };
}

describe('ARCH-8 registerShutdown', () => {
  it('closes the app and exits 0 on SIGTERM', async () => {
    const app = fakeApp(async () => {});
    const exit = vi.fn();
    const source = new EventEmitter();

    const shutdown = registerShutdown(app, {
      source: source as unknown as SignalSource,
      exit,
    });

    await shutdown('SIGTERM');

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(app.log.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'graceful shutdown started');
    expect(app.log.info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'graceful shutdown complete');
  });

  it('is idempotent: a repeated signal does not close/exit twice', async () => {
    let resolveClose!: () => void;
    const gate = new Promise<void>((r) => (resolveClose = r));
    const app = fakeApp(() => gate);
    const exit = vi.fn();

    const shutdown = registerShutdown(app, { exit });

    const first = shutdown('SIGTERM');
    // Second signal arrives while the first close is still pending.
    await shutdown('SIGINT');
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(app.log.info).toHaveBeenCalledWith(
      { signal: 'SIGINT' },
      'shutdown already in progress; ignoring signal',
    );

    resolveClose();
    await first;
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when app.close rejects', async () => {
    const app = fakeApp(async () => {
      throw new Error('boom');
    });
    const exit = vi.fn();

    const shutdown = registerShutdown(app, { exit });
    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    expect(app.log.error).toHaveBeenCalled();
  });

  it('subscribes to the configured signals on the injected source', async () => {
    const app = fakeApp(async () => {});
    const exit = vi.fn();
    const source = new EventEmitter();

    registerShutdown(app, {
      signals: ['SIGTERM', 'SIGINT'],
      source: source as unknown as SignalSource,
      exit,
    });

    expect(source.listenerCount('SIGTERM')).toBe(1);
    expect(source.listenerCount('SIGINT')).toBe(1);

    source.emit('SIGTERM');
    // Let the async handler run to completion.
    await new Promise((r) => setImmediate(r));

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
