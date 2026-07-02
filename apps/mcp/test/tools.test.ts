import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsProjectRepo } from '@po/server';
import { createTools, type ToolDef } from '../src/tools.js';
import { byName, call, cleanup, data, fixedNow, makeTmpRoot } from './helpers.js';

const FUNCTIONS_DIR = path.join('openspec', 'specs', 'functions');
const EXPECTED_TOOLS = [
  'list_projects',
  'get_project',
  'list_requirements',
  'get_requirement',
  'create_requirement',
  'update_requirement',
  'link_requirements',
  'delete_requirement',
  'export_project',
];

describe('T-1002 MCP tools wrapper (S31–S34)', () => {
  let root: string;
  let tools: Map<string, ToolDef>;

  beforeEach(async () => {
    root = await makeTmpRoot();
    tools = byName(createTools(root, fixedNow));
    await new FsProjectRepo(root).create('P', fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('registers all nine expected tools with input schemas', () => {
    const defs = createTools(root, fixedNow);
    expect(defs.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of defs) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(typeof t.inputSchema).toBe('object');
    }
  });

  it('list_projects returns the created project', async () => {
    const res = await call(tools, 'list_projects', {});
    const projects = data(res).projects as Array<{ id: string }>;
    expect(projects.map((p) => p.id)).toContain('P');
  });

  it('get_project returns a project; missing id → NOT_FOUND error', async () => {
    const ok = await call(tools, 'get_project', { projectId: 'P' });
    expect((data(ok).project as { id: string }).id).toBe('P');

    const miss = await call(tools, 'get_project', { projectId: 'nope' });
    expect(miss.isError).toBe(true);
    expect(miss.content[0]?.text).toContain('NOT_FOUND');
  });

  // S31
  it('list_requirements on an empty project → empty array (not an error)', async () => {
    const res = await call(tools, 'list_requirements', { projectId: 'P' });
    expect(res.isError).toBeUndefined();
    expect(data(res).requirements).toEqual([]);
    expect(data(res).broken).toEqual([]);
  });

  it('list_requirements on a missing project → NOT_FOUND error', async () => {
    const res = await call(tools, 'list_requirements', { projectId: 'ghost' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('NOT_FOUND');
  });

  it('create_requirement returns the created requirement and writes a file', async () => {
    const res = await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'User Login',
      criticality: 'HIGH',
      implemented: true,
    });
    const req = data(res).requirement as { slug: string; name: string; createdAt: string };
    expect(req.slug).toBe('user-login');
    expect(req.name).toBe('User Login');
    expect(req.createdAt).toBe(fixedNow());
    const file = path.join(root, 'P', FUNCTIONS_DIR, 'user-login.md');
    expect((await fs.stat(file)).isFile()).toBe(true);
  });

  // S32 — invalid enum value (Zod) → error, no file created.
  it('create_requirement with invalid criticality → error, no file created', async () => {
    const res = await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Bad',
      criticality: 'ULTRA',
      implemented: true,
    });
    expect(res.isError).toBe(true);
    const dir = path.join(root, 'P', FUNCTIONS_DIR);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
  });

  // S32 — passes Zod but violates the domain rule (implemented=false needs target).
  it('create_requirement implemented=false without target → VALIDATION error, no file', async () => {
    const res = await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Needs Target',
      criticality: 'LOW',
      implemented: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('VALIDATION');
    const entries = await fs.readdir(path.join(root, 'P', FUNCTIONS_DIR));
    expect(entries).toEqual([]);
  });

  it('create_requirement duplicate name → UNIQUENESS error', async () => {
    await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Dup',
      criticality: 'LOW',
      implemented: true,
    });
    const res = await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'dup',
      criticality: 'LOW',
      implemented: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('UNIQUENESS');
  });

  it('get_requirement returns a requirement; unknown slug → NOT_FOUND', async () => {
    await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Alpha',
      criticality: 'LOW',
      implemented: true,
    });
    const ok = await call(tools, 'get_requirement', { projectId: 'P', slug: 'alpha' });
    expect((data(ok).requirement as { name: string }).name).toBe('Alpha');

    const miss = await call(tools, 'get_requirement', { projectId: 'P', slug: 'ghost' });
    expect(miss.isError).toBe(true);
    expect(miss.content[0]?.text).toContain('NOT_FOUND');
  });

  it('update_requirement returns the updated state; keeps slug', async () => {
    await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Orig',
      criticality: 'LOW',
      implemented: true,
    });
    const res = await call(tools, 'update_requirement', {
      projectId: 'P',
      slug: 'orig',
      name: 'Renamed',
      criticality: 'HIGH',
      implemented: true,
    });
    const req = data(res).requirement as { slug: string; name: string };
    expect(req.slug).toBe('orig');
    expect(req.name).toBe('Renamed');

    const miss = await call(tools, 'update_requirement', {
      projectId: 'P',
      slug: 'ghost',
      name: 'X',
      criticality: 'LOW',
      implemented: true,
    });
    expect(miss.isError).toBe(true);
    expect(miss.content[0]?.text).toContain('NOT_FOUND');
  });

  it('link_requirements creates a link and returns the source requirement', async () => {
    for (const name of ['Parent', 'Child']) {
      await call(tools, 'create_requirement', {
        projectId: 'P',
        type: 'FUNCTION',
        name,
        criticality: 'LOW',
        implemented: true,
      });
    }
    const res = await call(tools, 'link_requirements', {
      projectId: 'P',
      sourceSlug: 'parent',
      type: 'PARENT_OF',
      targetSlug: 'child',
    });
    const req = data(res).requirement as {
      slug: string;
      links: Array<{ type: string; targetSlug: string }>;
    };
    expect(req.slug).toBe('parent');
    expect(req.links).toContainEqual({ type: 'PARENT_OF', targetSlug: 'child' });
  });

  it('link_requirements self-link → SELF_LINK error', async () => {
    await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Solo',
      criticality: 'LOW',
      implemented: true,
    });
    const res = await call(tools, 'link_requirements', {
      projectId: 'P',
      sourceSlug: 'solo',
      type: 'RELATES_TO',
      targetSlug: 'solo',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('SELF_LINK');
  });

  // S33
  it('link_requirements cycle → CYCLE integrity error', async () => {
    for (const name of ['A', 'B']) {
      await call(tools, 'create_requirement', {
        projectId: 'P',
        type: 'FUNCTION',
        name,
        criticality: 'LOW',
        implemented: true,
      });
    }
    await call(tools, 'link_requirements', {
      projectId: 'P',
      sourceSlug: 'a',
      type: 'PARENT_OF',
      targetSlug: 'b',
    });
    const res = await call(tools, 'link_requirements', {
      projectId: 'P',
      sourceSlug: 'b',
      type: 'PARENT_OF',
      targetSlug: 'a',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('CYCLE');
  });

  it('delete_requirement removes a leaf; blocks a node with children', async () => {
    for (const name of ['Root', 'Leaf']) {
      await call(tools, 'create_requirement', {
        projectId: 'P',
        type: 'FUNCTION',
        name,
        criticality: 'LOW',
        implemented: true,
      });
    }
    await call(tools, 'link_requirements', {
      projectId: 'P',
      sourceSlug: 'root',
      type: 'PARENT_OF',
      targetSlug: 'leaf',
    });
    // Parent still has a child → blocked.
    const blocked = await call(tools, 'delete_requirement', { projectId: 'P', slug: 'root' });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain('HAS_CHILDREN');

    // Leaf deletes cleanly.
    const ok = await call(tools, 'delete_requirement', { projectId: 'P', slug: 'leaf' });
    expect(data(ok)).toEqual({ deleted: true, slug: 'leaf' });
    await expect(fs.stat(path.join(root, 'P', FUNCTIONS_DIR, 'leaf.md'))).rejects.toBeTruthy();
  });

  // S34
  it('export_project (zip) writes a valid archive and returns its path', async () => {
    await call(tools, 'create_requirement', {
      projectId: 'P',
      type: 'FUNCTION',
      name: 'Feature',
      criticality: 'LOW',
      implemented: true,
    });
    const res = await call(tools, 'export_project', { projectId: 'P', format: 'zip' });
    const out = data(res) as { path: string; filename: string; bytes: number };
    expect(out.filename).toBe('P.zip');
    expect(out.bytes).toBeGreaterThan(0);
    const buf = await fs.readFile(out.path);
    // PK zip magic bytes.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    await fs.rm(out.path, { force: true });
  });

  it('export_project (targz) writes a gzip archive via the stream path', async () => {
    const res = await call(tools, 'export_project', { projectId: 'P', format: 'targz' });
    const out = data(res) as { path: string; filename: string; bytes: number };
    expect(out.filename).toBe('P.tar.gz');
    expect(out.bytes).toBeGreaterThan(0);
    const buf = await fs.readFile(out.path);
    // gzip magic bytes.
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
    await fs.rm(out.path, { force: true });
  });

  it('export_project on a missing project → NOT_FOUND error', async () => {
    const res = await call(tools, 'export_project', { projectId: 'ghost', format: 'zip' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('NOT_FOUND');
  });

  it('default clock is used when no now() is injected (smoke)', async () => {
    const t = byName(createTools(root));
    const res = await call(t, 'list_requirements', { projectId: 'P' });
    expect(res.isError).toBeUndefined();
  });
});
