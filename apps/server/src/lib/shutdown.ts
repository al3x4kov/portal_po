import type { FastifyInstance } from 'fastify';

/** The minimal signal source we listen on (real `process` in production). */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** The subset of the app the shutdown routine needs (keeps it unit-testable). */
export type ShutdownApp = Pick<FastifyInstance, 'close'> & {
  log: Pick<FastifyInstance['log'], 'info' | 'error'>;
};

export interface RegisterShutdownOptions {
  /** Signals that trigger a graceful stop. Defaults to SIGTERM + SIGINT. */
  signals?: NodeJS.Signals[];
  /** Signal source to subscribe on. Defaults to the global `process`. */
  source?: SignalSource;
  /** Process-exit hook (injected for tests). Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * ARCH-8: wire graceful shutdown for a Fastify app.
 *
 * On SIGTERM/SIGINT we `await app.close()` — Fastify stops accepting new
 * connections, drains in-flight requests, and runs `onClose` hooks (closing
 * plugins and flushing the pino logger) — then exit with code 0. Because the
 * cross-process project lock is taken per operation and released in `finally`
 * (see `lib/projectLock.ts`), draining in-flight requests guarantees no lock is
 * still held once `close()` resolves.
 *
 * The routine is idempotent: a second signal while a shutdown is already in
 * progress is logged and ignored (no double `close`, no double `exit`). No
 * timers are registered, so the handler adds nothing that could leak or keep
 * the event loop alive.
 *
 * @returns the `shutdown` function (accepting the signal name) so callers/tests
 *   can invoke the exact same routine the signal handlers use.
 */
export function registerShutdown(
  app: ShutdownApp,
  opts: RegisterShutdownOptions = {},
): (signal: NodeJS.Signals) => Promise<void> {
  const signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  const source = opts.source ?? process;
  const exit = opts.exit ?? ((code: number): void => void process.exit(code));

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      app.log.info({ signal }, 'shutdown already in progress; ignoring signal');
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'graceful shutdown started');
    try {
      await app.close();
      app.log.info({ signal }, 'graceful shutdown complete');
      exit(0);
    } catch (err) {
      app.log.error({ err, signal }, 'error during graceful shutdown');
      exit(1);
    }
  };

  for (const signal of signals) {
    source.on(signal, () => {
      void shutdown(signal);
    });
  }

  return shutdown;
}
