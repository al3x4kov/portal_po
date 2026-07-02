import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { serialize, type Requirement } from '@po/core';
import { buildApp } from '../src/app.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';

/**
 * QA-2 · performance budget for the read-heavy list endpoint. `GET
 * /api/projects/:id/requirements` reads and parses every requirement file for a
 * project on each call; it must stay responsive as a project grows. Budget: a
 * project of ≥500 requirements lists under 800ms median (p50) locally, with a
 * generous cap that still catches an accidental O(n²) parse/serialize
 * regression rather than benchmarking absolute throughput.
 *
 * Seeding writes the spec files directly (via core `serialize`) rather than
 * through 500 sequential HTTP creates: the create path re-reads every existing
 * file for uniqueness on each call (O(n²)), which is a property of *writes*, not
 * of the *read* path this test measures.
 */

const N = 500;
const P50_BUDGET_MS = 800;
const HARD_CAP_MS = 2000;
const FUNCTIONS_DIR = path.join('openspec', 'specs', 'functions');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

describe('QA-2 · GET /requirements performance (≥500 requirements)', () => {
  let app: FastifyInstance;
  let root: string;
  const projectId = 'Perf';

  beforeEach(async () => {
    root = await makeTmpRoot();
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: projectId } });

    // Seed N requirements by writing their spec files directly (fast path).
    const dir = path.join(root, projectId, FUNCTIONS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const slug = `req-${String(i).padStart(4, '0')}`;
        const req: Requirement = {
          slug,
          type: 'FUNCTION',
          name: `Требование номер ${i}`,
          criticality: 'MEDIUM',
          implemented: true,
          description: 'Короткое описание требования для нагрузочного чтения списка.',
          links: [],
          createdAt: fixedNow(),
          updatedAt: fixedNow(),
        };
        return fs.writeFile(path.join(dir, `${slug}.md`), serialize(req), 'utf8');
      }),
    );
  }, 30000);
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  it(`lists ${N}+ requirements within the p50 budget`, async () => {
    // Warm-up read (prime any lazy init), then measure repeated reads.
    const warm = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/requirements`,
    });
    expect(warm.statusCode).toBe(200);
    expect(warm.json().requirements).toHaveLength(N);

    const samples: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const start = performance.now();
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/requirements`,
      });
      samples.push(performance.now() - start);
      expect(res.statusCode).toBe(200);
    }

    const p50 = median(samples);
    const worst = Math.max(...samples);
    expect(
      p50,
      `p50=${p50.toFixed(1)}ms samples=${samples.map((s) => s.toFixed(0)).join(',')}`,
    ).toBeLessThan(P50_BUDGET_MS);
    expect(worst, `worst=${worst.toFixed(1)}ms`).toBeLessThan(HARD_CAP_MS);
  });
});
