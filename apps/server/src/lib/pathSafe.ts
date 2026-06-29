import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PathSafetyError } from './errors.js';

/**
 * Resolve `segments` against `root` and guarantee the result stays inside `root`.
 *
 * Pure path arithmetic only (no fs access): rejects `..` traversal and absolute
 * segments that would escape. Use {@link assertRealpathWithin} additionally to
 * defend against symlinks that point outside the root.
 *
 * @throws {PathSafetyError} when the resolved path escapes `root`.
 */
export function resolveSafe(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new PathSafetyError(
      `Path escapes the Projects root: "${path.join(...segments)}" resolves outside "${resolvedRoot}".`,
    );
  }
  return target;
}

/**
 * Defend against symlink escapes: realpath the nearest existing ancestor of
 * `target` and ensure the real location is still inside the real `root`.
 * Safe to call on not-yet-existing paths (only existing ancestors are resolved).
 *
 * @throws {PathSafetyError} when the real path escapes `root`.
 */
export async function assertRealpathWithin(root: string, target: string): Promise<string> {
  const realRoot = await fs.realpath(path.resolve(root));

  const tail: string[] = [];
  let cur = path.resolve(target);
  // Walk up to the longest existing ancestor.
  for (;;) {
    try {
      const realCur = await fs.realpath(cur);
      const real = tail.length === 0 ? realCur : path.join(realCur, ...tail);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new PathSafetyError(`Path escapes the Projects root via symlink: "${target}".`);
      }
      return target;
    } catch (err) {
      if (err instanceof PathSafetyError) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached filesystem root without finding an existing ancestor.
        throw new PathSafetyError(`Cannot verify path safety for "${target}".`);
      }
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
