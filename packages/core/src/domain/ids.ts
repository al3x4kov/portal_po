import { ulid } from 'ulid';

/** Encapsulated ULID generation for requirement ids (sortable, collision-free). */
export function newId(): string {
  return ulid();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a syntactically valid ULID. */
export function isValidId(value: string): boolean {
  return ULID_RE.test(value);
}
