import { CycleError, DomainError, HasChildrenError } from '@po/core';

/** Requested resource (project / requirement) does not exist. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/** A conflicting resource already exists (e.g. duplicate project name, duplicate link). */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

/**
 * The requirement's parent on disk is not the one the client moved it from:
 * someone else (or an AI import) re-parented it in the meantime. The move is
 * refused rather than silently overwriting that change; `actualParentSlug`
 * lets the client show what the tree looks like now.
 */
export class StaleParentError extends DomainError {
  public readonly actualParentSlug: string | null;
  constructor(slug: string, expected: string | null, actual: string | null) {
    super(
      'STALE_PARENT',
      `Requirement "${slug}" now hangs under ${actual === null ? 'the root' : `"${actual}"`}, not ${
        expected === null ? 'the root' : `"${expected}"`
      }; refresh the tree and repeat the move.`,
    );
    this.actualParentSlug = actual;
  }
}

/** A path resolved outside the allowed Projects/ root (path traversal / symlink escape). */
export class PathSafetyError extends DomainError {
  constructor(message: string) {
    super('PATH_UNSAFE', message);
  }
}

/**
 * A malformed/incomplete archive or one whose contents fail validation.
 * `details` carries the full list of concrete violations when an archive is
 * rejected for a broken link graph (SA-3), so the client sees every problem at
 * once rather than one-at-a-time.
 */
export class ArchiveError extends DomainError {
  public readonly details?: readonly string[];
  constructor(message: string, details?: readonly string[]) {
    super('ARCHIVE', message);
    this.details = details;
  }
}

/** A syntactically malformed request (e.g. an unparseable multipart upload). */
export class BadRequestError extends DomainError {
  constructor(message: string) {
    super('BAD_REQUEST', message);
  }
}

/**
 * An upstream AI Hub call failed (network, auth, rate-limit, empty response).
 * Maps to HTTP 502. The message is sanitized upstream so the API key never
 * appears in it (Task 8 security).
 */
export class AiUpstreamError extends DomainError {
  constructor(message: string) {
    super('AI_UPSTREAM', message);
  }
}

/**
 * A composition-root invariant was violated: a required collaborator was not
 * wired into a service (a programmer contract breach, BE-7) — not a runtime
 * fault triggered by input or the filesystem. Kept deliberately OUTSIDE the
 * {@link DomainError} hierarchy so it never masquerades as a mapped domain
 * fault: it carries no error `code`, so {@link httpStatusForCode} does not
 * classify it and it stands out from genuine runtime failures. If it ever
 * surfaces it signals a bug to fix in `factory.ts`, not a client condition.
 */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

/**
 * Structured, machine-readable details for specific domain errors (ARCH-11).
 * Shared by the REST error handler and the MCP tool wrapper so both transports
 * surface the same payload (e.g. a cycle's `path`, a node's blocking `children`)
 * instead of collapsing it into a plain string.
 */
export function domainErrorDetails(err: DomainError): unknown {
  if (err instanceof CycleError) return { path: err.path };
  if (err instanceof HasChildrenError) return { children: err.children };
  if (err instanceof StaleParentError) return { actualParentSlug: err.actualParentSlug };
  if (err instanceof ArchiveError && err.details && err.details.length > 0) {
    return { violations: err.details };
  }
  return undefined;
}

/**
 * Map a DomainError code to an HTTP status.
 * Everything unknown falls back to 500 in the error handler.
 */
export function httpStatusForCode(code: string): number {
  switch (code) {
    case 'PATH_UNSAFE':
    case 'BAD_REQUEST':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'AI_UPSTREAM':
      return 502;
    case 'UNIQUENESS':
    case 'CONFLICT':
    case 'CYCLE':
    case 'MULTIPLE_PARENT':
    case 'HAS_CHILDREN':
    case 'STALE_PARENT':
      return 409;
    case 'VALIDATION':
    case 'PARSE':
    case 'SELF_LINK':
    case 'TYPE_MISMATCH':
    case 'ARCHIVE':
      return 422;
    default:
      return 500;
  }
}
