import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serialize, type Link, type Requirement } from '@po/core';
import { createProjectService } from '../src/factory.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import { assertPerfBudget, median, PERF_DISABLED } from './perfBaseline.js';

/**
 * SA-5 · NFR-3 · Import/export perf budget at the TARGET scale.
 *
 * NFR-3 already covers CRUD/tree/render @1000 (perf.test.ts), but NOT the
 * archive round-trip — the single heaviest operation the product performs:
 * export packs 1000 `.md`, and import UNPACKS them, PARSES + VALIDATES every
 * file, runs the FULL link-graph integrity check (cycles / single-parent /
 * dangling / self-link / missing-inverse) over ~1000 links, then atomically
 * renames the staged tree into Projects/. This benchmark seeds a realistic
 * project (1000 requirements wired into 100 parent/child groups → 1000 links)
 * and measures export + import p95 across several rounds.
 *
 * Measured actuals on the reference machine (Apple Silicon, local SSD, isolated
 * run, 2026-07-07): export zip p95 ≈ 87 ms, import zip p95 ≈ 266 ms — well
 * inside the TODO/SA-5 goal of round-trip p95 < 3 s. Enforced gates take a
 * ~×3 anti-flake margin over the fact (slower shared CI runners) and a hard cap
 * guards against an accidental O(n²) regression. The trend guard (QA-6) catches
 * cumulative drift that stays under the absolute gate.
 */

const N = 1000;
const GROUP = 10; // 100 parents × 9 children each → ~1000 links total

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Enforced export p95 gate (fact ≈ 87 ms; settled-round margin, cf. perf.test). */
const EXPORT_GATE_MS = envInt('EXPORT_P95_GATE_MS', 400);
/** Enforced import p95 gate (fact ≈ 266 ms → ~×3.4 headroom over a settled round). */
const IMPORT_GATE_MS = envInt('IMPORT_P95_GATE_MS', 900);
const EXPORT_HARD_CAP_MS = envInt('EXPORT_HARD_CAP_MS', 1500);
const IMPORT_HARD_CAP_MS = envInt('IMPORT_HARD_CAP_MS', 3000);
/** Informational fit-criteria (logged; the SA-5 goal is round-trip < 3000 ms). */
const EXPORT_TARGET_MS = 500;
const IMPORT_TARGET_MS = 1500;
/** Best-effort peak-memory ceiling for a single round-trip (rss delta). */
const RSS_CAP_MB = envInt('IMPORT_RSS_CAP_MB', 256);

const EXPORT_SAMPLES = 8;
const IMPORT_SAMPLES = 5;

const slugOf = (i: number): string => `req-${String(i).padStart(4, '0')}`;

function seedRequirement(i: number): Requirement {
  const groupBase = Math.floor(i / GROUP) * GROUP;
  const links: Link[] = [];
  if (i === groupBase) {
    for (let c = 1; c < GROUP && groupBase + c < N; c += 1) {
      links.push({ type: 'PARENT_OF', targetSlug: slugOf(groupBase + c) });
    }
  } else {
    links.push({ type: 'CHILD_OF', targetSlug: slugOf(groupBase) });
  }
  return {
    slug: slugOf(i),
    type: 'FUNCTION',
    name: `Требование номер ${i}`,
    criticality: 'MEDIUM',
    implemented: true,
    description: 'Короткое описание требования для нагрузочного прогона архива.',
    links,
    createdAt: fixedNow(),
    updatedAt: fixedNow(),
  };
}

// Heavy benchmark: gated behind RUN_PERF=1 (npm run test:perf) so the default
// coverage-instrumented `npm test` stays deterministic (see PERF_DISABLED).
describe.skipIf(PERF_DISABLED)(
  `SA-5 · NFR-3 archive round-trip benchmark (${N} requirements)`,
  () => {
    let root: string;
    let scratch: string;
    let svc: ReturnType<typeof createProjectService>;
    let archiveFile: string;
    const projectId = 'Perf';

    beforeAll(async () => {
      root = await makeTmpRoot();
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'po-arch-perf-'));
      svc = createProjectService({ projectsRoot: root, now: fixedNow });
      await svc.create(projectId);

      const dir = path.join(root, projectId, 'openspec', 'specs', 'functions');
      await fs.mkdir(dir, { recursive: true });
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fs.writeFile(path.join(dir, `${slugOf(i)}.md`), serialize(seedRequirement(i)), 'utf8'),
        ),
      );

      // Pre-export once: this archive feeds every import sample (import never
      // consumes it), and warms fs caches before measurement.
      const out = await svc.export(projectId, 'zip');
      archiveFile = path.join(scratch, 'seed.zip');
      await fs.writeFile(archiveFile, out.body as Buffer);
    }, 120_000);

    afterAll(async () => {
      await cleanup(root);
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    });

    it(`export zip of ${N} requirements: p95 within budget`, { timeout: 180_000 }, async () => {
      await assertPerfBudget({
        op: `export zip @${N}`,
        baselineKey: 'archive.export.zip@1000',
        gateMs: EXPORT_GATE_MS,
        hardCapMs: EXPORT_HARD_CAP_MS,
        targetMs: EXPORT_TARGET_MS,
        scale: N,
        collect: async () => {
          const samples: number[] = [];
          for (let i = 0; i < EXPORT_SAMPLES; i += 1) {
            const start = performance.now();
            const out = await svc.export(projectId, 'zip');
            samples.push(performance.now() - start);
            expect(Buffer.isBuffer(out.body)).toBe(true);
          }
          return samples;
        },
      });
    });

    it(
      `import zip of ${N} requirements (unpack + validate + integrity + rename): p95 within budget`,
      { timeout: 240_000 },
      async () => {
        let seq = 0;
        await assertPerfBudget({
          op: `import zip @${N}`,
          baselineKey: 'archive.import.zip@1000',
          gateMs: IMPORT_GATE_MS,
          hardCapMs: IMPORT_HARD_CAP_MS,
          targetMs: IMPORT_TARGET_MS,
          scale: N,
          collect: async () => {
            const samples: number[] = [];
            for (let i = 0; i < IMPORT_SAMPLES; i += 1) {
              seq += 1;
              const name = `Copy-${seq}`;
              const start = performance.now();
              const proj = await svc.import(archiveFile, name);
              samples.push(performance.now() - start);
              // Reclaim disk + free the name so the next sample re-imports fresh.
              await fs.rm(path.join(root, proj.id), { recursive: true, force: true });
            }
            return samples;
          },
        });
      },
    );

    it(
      `round-trip preserves every requirement + link and stays within the memory ceiling`,
      { timeout: 120_000 },
      async () => {
        const deltas: number[] = [];
        let importedId = '';
        // A few round-trips; take the median rss delta so a single GC blip does
        // not decide the memory verdict.
        for (let i = 0; i < 3; i += 1) {
          if (importedId)
            await fs.rm(path.join(root, importedId), { recursive: true, force: true });
          const before = process.memoryUsage().rss;
          const proj = await svc.import(archiveFile, `Mem-${i}`);
          const after = process.memoryUsage().rss;
          deltas.push((after - before) / (1024 * 1024));
          importedId = proj.id;
        }

        // Integrity of the last imported copy: exact count, unique slugs, no
        // broken files, links preserved through the round-trip.
        const repo = new FsRequirementRepo(root, importedId);
        const { requirements, broken } = await repo.loadAll();
        expect(broken).toEqual([]);
        expect(requirements).toHaveLength(N);
        expect(new Set(requirements.map((r) => r.slug)).size).toBe(N);
        const parent = requirements.find((r) => r.slug === slugOf(0))!;
        expect(parent.links).toContainEqual({ type: 'PARENT_OF', targetSlug: slugOf(1) });

        const medDelta = median(deltas);
        console.log(
          `[PERF-MEM] import round-trip @${N} rss delta: median=${medDelta.toFixed(1)}MB ` +
            `samples=[${deltas.map((d) => d.toFixed(1)).join(',')}] (cap ${RSS_CAP_MB}MB)`,
        );
        // Best-effort anti-regression: the archive of 1000 small files is only a
        // few hundred KB, so a large rss delta would signal a real buffering leak.
        expect(medDelta).toBeLessThan(RSS_CAP_MB);

        await fs.rm(path.join(root, importedId), { recursive: true, force: true });
      },
    );
  },
);
