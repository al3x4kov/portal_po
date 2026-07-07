import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { serialize, type Requirement } from '@po/core';
import { buildApp } from '../src/app.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import { assertPerfBudget, percentile, PERF_DISABLED } from './perfBaseline.js';

/**
 * QA-4 · Concurrent-writer load on ONE project (lock contention).
 *
 * perf.test.ts measures p95 SEQUENTIALLY with a single client. This benchmark
 * fires K writers at the SAME project at once, so they genuinely contend for the
 * cross-process project lock (ADR-003 / projectLock.ts): only one create's
 * read-modify-write runs at a time and the rest queue on `proper-lockfile`
 * retries. We measure the tail latency UNDER that contention, assert a lock-wait
 * budget, and — the correctness half — prove that at K concurrent requests NONE
 * fails to a stale/timeout, the requirement count is exact, every slug is
 * unique, and no file is left half-written (`broken === []`).
 *
 * Measured actuals on the reference machine (Apple Silicon, local SSD, isolated
 * run, 2026-07-07): K=8 p95 ≈ 325 ms, K=16 p95 ≈ 781 ms, 0 failures, integrity
 * intact. The enforced gate takes a wide anti-flake margin over the fact.
 */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Parallel writers contending for one project lock (moderate for determinism). */
const K = envInt('CONCURRENT_WRITERS', 12);
/** Preseed so each create's loadAll under the lock is non-trivial. */
const PRESEED = 300;
/** Enforced p95 lock-wait gate (K=12 fact ≈ 550 ms → wide margin). */
const P95_GATE_MS = envInt('CONCURRENT_P95_GATE_MS', 2000);
const HARD_CAP_MS = envInt('CONCURRENT_HARD_CAP_MS', 5000);
/** Informational lock-wait budget (logged). */
const TARGET_MS = 1500;
/** Integrity waves: exactly K·WAVES creates on a fresh project. */
const WAVES = 3;

async function seed(root: string, projectId: string, count: number): Promise<void> {
  const dir = path.join(root, projectId, 'openspec', 'specs', 'functions');
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const slug = `seed-${String(i).padStart(4, '0')}`;
      const req: Requirement = {
        slug,
        type: 'FUNCTION',
        name: `Seed ${i}`,
        criticality: 'MEDIUM',
        implemented: true,
        description: 'Преднаполнение для нагрузки под локом.',
        links: [],
        createdAt: fixedNow(),
        updatedAt: fixedNow(),
      };
      return fs.writeFile(path.join(dir, `${slug}.md`), serialize(req), 'utf8');
    }),
  );
}

// Heavy benchmark: gated behind RUN_PERF=1 (npm run test:perf) so the default
// coverage-instrumented `npm test` stays deterministic (see PERF_DISABLED).
describe.skipIf(PERF_DISABLED)(
  `QA-4 · concurrent writers on one project (K=${K}, lock contention)`,
  () => {
    let app: FastifyInstance;
    let root: string;
    const projectId = 'Contend';
    let seq = 0; // globally unique names across rounds

    beforeAll(async () => {
      root = await makeTmpRoot();
      app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
      await app.inject({ method: 'POST', url: '/api/projects', payload: { name: projectId } });
      await seed(root, projectId, PRESEED);
      // Warm-up wave (also verifies the contended path returns 201).
      const warm = await Promise.all(
        Array.from({ length: K }, () => {
          seq += 1;
          return app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/requirements`,
            payload: {
              type: 'FUNCTION',
              name: `Warm ${seq}`,
              criticality: 'HIGH',
              implemented: true,
              description: 'warm-up',
            },
          });
        }),
      );
      expect(warm.every((r) => r.statusCode === 201)).toBe(true);
    }, 60_000);

    afterAll(async () => {
      await app.close();
      await cleanup(root);
    });

    it(
      `K=${K} writers contend for the lock and stay within the p95 wait budget`,
      {
        timeout: 180_000,
      },
      async () => {
        await assertPerfBudget({
          op: `concurrent create (K=${K})`,
          baselineKey: `concurrent.create.k${K}`,
          gateMs: P95_GATE_MS,
          hardCapMs: HARD_CAP_MS,
          targetMs: TARGET_MS,
          // Lock-contention tail latency swings widely under a parallel test suite;
          // widen the trend tolerance so it flags real drift, not scheduler noise.
          growthPct: 120,
          collect: async () => {
            // One contention wave: K creates fired together, each timed from its own
            // dispatch so the sample is the true per-request latency UNDER the lock.
            const latencies = await Promise.all(
              Array.from({ length: K }, () => {
                seq += 1;
                const name = `Contend ${seq}`;
                const start = performance.now();
                return app
                  .inject({
                    method: 'POST',
                    url: `/api/projects/${projectId}/requirements`,
                    payload: {
                      type: 'FUNCTION',
                      name,
                      criticality: 'HIGH',
                      implemented: true,
                      description: 'concurrent write under lock',
                    },
                  })
                  .then((res) => {
                    // No writer may lose the lock to stale/timeout under contention.
                    expect(res.statusCode, res.body).toBe(201);
                    return performance.now() - start;
                  });
              }),
            );
            return latencies;
          },
        });
      },
    );

    it(
      `K=${K}·${WAVES} concurrent writers: none fails, count exact, slugs unique, broken=[]`,
      { timeout: 180_000 },
      async () => {
        // Fresh project so the final count is deterministic (independent of the
        // budget test's retry rounds above).
        const pid = 'ContendIntegrity';
        await app.inject({ method: 'POST', url: '/api/projects', payload: { name: pid } });

        const statuses: number[] = [];
        const waitSamples: number[] = [];
        let n = 0;
        for (let w = 0; w < WAVES; w += 1) {
          const results = await Promise.all(
            Array.from({ length: K }, () => {
              n += 1;
              const name = `Wave ${w}-${n}`;
              const start = performance.now();
              return app
                .inject({
                  method: 'POST',
                  url: `/api/projects/${pid}/requirements`,
                  payload: {
                    type: 'FUNCTION',
                    name,
                    criticality: 'MEDIUM',
                    implemented: true,
                    description: 'integrity wave',
                  },
                })
                .then((res) => {
                  waitSamples.push(performance.now() - start);
                  return res.statusCode;
                });
            }),
          );
          statuses.push(...results);
        }

        // No request degraded to a stale-lock/timeout or a lost-update conflict.
        expect(
          statuses.every((s) => s === 201),
          `statuses=${statuses.join(',')}`,
        ).toBe(true);

        const repo = new FsRequirementRepo(root, pid);
        const { requirements, broken } = await repo.loadAll();
        expect(broken).toEqual([]); // no half-written / clobbered files
        expect(requirements).toHaveLength(K * WAVES); // exact, nothing dropped
        expect(new Set(requirements.map((r) => r.slug)).size).toBe(K * WAVES); // unique slugs

        console.log(
          `[PERF-LOCK] K=${K}·${WAVES} on one project: ${statuses.length} creates, 0 failures, ` +
            `wait p95=${percentile(waitSamples, 95).toFixed(1)}ms worst=${Math.max(...waitSamples).toFixed(1)}ms`,
        );

        await fs.rm(path.join(root, pid), { recursive: true, force: true });
      },
    );
  },
);
