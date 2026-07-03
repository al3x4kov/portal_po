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

/** A path resolved outside the allowed Projects/ root (path traversal / symlink escape). */
export class PathSafetyError extends DomainError {
  constructor(message: string) {
    super('PATH_UNSAFE', message);
  }
}

/** A malformed/incomplete archive or one whose contents fail validation. */
export class ArchiveError extends DomainError {
  constructor(message: string) {
    super('ARCHIVE', message);
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
 * Structured, machine-readable details for specific domain errors (ARCH-11).
 * Shared by the REST error handler and the MCP tool wrapper so both transports
 * surface the same payload (e.g. a cycle's `path`, a node's blocking `children`)
 * instead of collapsing it into a plain string.
 */
export function domainErrorDetails(err: DomainError): unknown {
  if (err instanceof CycleError) return { path: err.path };
  if (err instanceof HasChildrenError) return { children: err.children };
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
