import lockfile from 'proper-lockfile';
import { ensureDir } from './ensureDir.js';
import { resolveSafe } from './pathSafe.js';

/**
 * Serialize project mutations across processes (ADR-003).
 *
 * The REST server and the MCP server share a single `PROJECTS_ROOT`, so an
 * in-process mutex is not enough: two OS processes could interleave a
 * read-modify-write on the same project and lose an update or produce a
 * duplicate slug (ARCH-2 / SA-8 / QA-3). We take an advisory, cross-process
 * file lock (`proper-lockfile`) keyed on the project directory. The `.lock`
 * marker lives next to the project directory under `PROJECTS_ROOT`.
 *
 * The lock is held only for the duration of a single mutation (create/update/
 * delete/link/unlink/import) and released in `finally`. `retries` let waiters
 * queue instead of failing fast; `stale` bounds recovery if a holder crashes.
 */
export async function withProjectLock<T>(
  projectsRoot: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Lock markers live in a hidden `.locks/` dir so they are never enumerated as
  // projects (FsProjectRepo.list skips dot-dirs) and survive create/import,
  // where the project directory itself does not exist yet. `realpath: false`
  // lets us lock a marker path that does not exist — only its parent must.
  const lockDir = resolveSafe(projectsRoot, '.locks');
  await ensureDir(lockDir);
  const target = resolveSafe(lockDir, projectId);
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 20_000,
    retries: { retries: 200, factor: 1.2, minTimeout: 15, maxTimeout: 250, randomize: true },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
