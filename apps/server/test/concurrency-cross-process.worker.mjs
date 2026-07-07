/* global process */
// Cross-process contention worker for concurrency-cross-process.test.ts (QA-1).
//
// Forked as a genuinely separate OS process (child_process.fork). It receives a
// SINGLE task over IPC, runs it against the shared PROJECTS_ROOT through the
// BUILT server services (so the on-disk proper-lockfile path — ADR-003 — is the
// only thing serializing writes across processes), and replies exactly once with
// { ok, result?, error? } before exiting. Nothing else may write to `.send`.
import { createProjectService, createRequirementService } from '../dist/factory.js';

/** Wall-clock timestamps; these tests assert structure/consistency, not times. */
const now = () => new Date().toISOString();

async function handle(task) {
  const ctx = { projectsRoot: task.projectsRoot, now };
  switch (task.kind) {
    case 'create-requirements': {
      const svc = createRequirementService(ctx, task.projectId);
      const result = [];
      for (const input of task.inputs) {
        try {
          const req = await svc.create(input);
          result.push({ ok: true, slug: req.slug });
        } catch (err) {
          result.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { ok: true, result };
    }
    case 'update-requirement': {
      const svc = createRequirementService(ctx, task.projectId);
      for (const input of task.updates) {
        await svc.update(task.slug, input);
      }
      return { ok: true };
    }
    case 'project-import': {
      const svc = createProjectService(ctx);
      const summary = await svc.import(task.archivePath, task.name);
      return { ok: true, result: { id: summary.id } };
    }
    case 'project-create': {
      const svc = createProjectService(ctx);
      const summary = await svc.create(task.name);
      return { ok: true, result: { id: summary.id } };
    }
    default:
      return { ok: false, error: `unknown task kind: ${String(task.kind)}` };
  }
}

process.on('message', (task) => {
  handle(task)
    .then((reply) => process.send?.(reply))
    .catch((err) =>
      process.send?.({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
    .finally(() => process.exit(0));
});
