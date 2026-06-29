import { DomainError } from '@po/core';

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

/**
 * Map a DomainError code to an HTTP status.
 * Everything unknown falls back to 500 in the error handler.
 */
export function httpStatusForCode(code: string): number {
  switch (code) {
    case 'PATH_UNSAFE':
      return 400;
    case 'NOT_FOUND':
      return 404;
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
