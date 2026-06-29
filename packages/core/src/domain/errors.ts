/** Base class for all domain-level errors. Carries a stable machine `code`. */
export class DomainError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when a requirement name is not unique within (project × type). */
export class UniquenessError extends DomainError {
  constructor(message: string) {
    super('UNIQUENESS', message);
  }
}

/** Thrown when a malformed `.md`/frontmatter cannot be parsed into a Requirement. */
export class ParseError extends DomainError {
  constructor(message: string) {
    super('PARSE', message);
  }
}

/** Thrown when field-level / conditional validation fails. */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

/** Thrown when a link would create a cycle. Exposes the offending path. */
export class CycleError extends DomainError {
  public readonly path: string[];
  constructor(path: string[]) {
    super('CYCLE', `Cycle detected: ${path.join(' -> ')}`);
    this.path = path;
  }
}

/** Thrown when a requirement would end up with more than one parent (CHILD_OF). */
export class MultipleParentError extends DomainError {
  constructor(message: string) {
    super('MULTIPLE_PARENT', message);
  }
}

/** Thrown when a requirement is linked to itself. */
export class SelfLinkError extends DomainError {
  constructor(message: string) {
    super('SELF_LINK', message);
  }
}

/** Thrown when a hierarchical link connects requirements of different types. */
export class TypeMismatchError extends DomainError {
  constructor(message: string) {
    super('TYPE_MISMATCH', message);
  }
}

/** Thrown when deleting a requirement that still has child requirements (FR-9.3). */
export class HasChildrenError extends DomainError {
  public readonly children: string[];
  constructor(children: string[]) {
    super('HAS_CHILDREN', `Cannot delete requirement with children: ${children.join(', ')}`);
    this.children = children;
  }
}
