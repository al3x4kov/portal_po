/**
 * Structured observability for the filesystem-mutating use cases (ARCH-7):
 * create / update / delete / link / unlink / import / export. A single {@link
 * OpLogger} port is injected into the services so both transports (REST over
 * Fastify's pino, MCP over stderr) emit the same shape and nothing is logged
 * when no logger is supplied (silent in unit tests).
 */

/** One structured log record for a single FS use-case operation. */
export interface OpLogEntry {
  /** Operation name, e.g. `create` / `update` / `delete` / `link` / `unlink` / `import` / `export`. */
  op: string;
  /** Project the operation targets. */
  projectId: string;
  /** Requirement slug when the operation is scoped to one (optional). */
  slug?: string;
  /** Whether the operation succeeded or raised. */
  outcome: 'ok' | 'error';
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Domain error code on failure (e.g. `CYCLE`, `NOT_FOUND`). */
  code?: string;
}

/** Sink for {@link OpLogEntry} records. Implementations must never throw. */
export interface OpLogger {
  op(entry: OpLogEntry): void;
}

/** Extracts a stable domain error code from an unknown throwable, if present. */
function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Run a mutating use case and emit exactly one structured {@link OpLogEntry}
 * (ARCH-7): timed, tagged with the outcome and — on failure — the domain error
 * code. A no-op passthrough when no logger was injected (silent in unit tests).
 *
 * @param slugOf optionally derive the logged slug from the result (e.g. the
 * slug assigned to a freshly-created requirement, unknown before it runs).
 */
export async function withOpLog<T>(
  log: OpLogger | undefined,
  meta: { op: string; projectId: string; slug?: string },
  fn: () => Promise<T>,
  slugOf?: (result: T) => string,
): Promise<T> {
  if (!log) return fn();
  const start = Date.now();
  try {
    const result = await fn();
    log.op({
      ...meta,
      slug: slugOf ? slugOf(result) : meta.slug,
      outcome: 'ok',
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    log.op({ ...meta, outcome: 'error', durationMs: Date.now() - start, code: codeOf(err) });
    throw err;
  }
}

/** Minimal pino-shaped logger surface (satisfied by Fastify's `app.log`). */
export interface PinoLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * Adapt a pino-like logger (Fastify's `app.log`) to an {@link OpLogger}.
 * Successes log at `info`, failures at `warn`; the message tag is `fs.op`.
 * When Fastify is built with `logger: false` this is a no-op, so tests stay
 * quiet without any special-casing.
 */
export function pinoOpLogger(log: PinoLike): OpLogger {
  return {
    op(entry: OpLogEntry): void {
      if (entry.outcome === 'ok') log.info(entry, 'fs.op');
      else log.warn(entry, 'fs.op');
    },
  };
}

/**
 * An {@link OpLogger} that writes one JSON line per entry to `stderr` (MCP):
 * stdout is reserved for the stdio JSON-RPC protocol, so all diagnostics go to
 * stderr to avoid corrupting the transport (ARCH-7).
 */
export function stderrOpLogger(): OpLogger {
  return {
    op(entry: OpLogEntry): void {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    },
  };
}
