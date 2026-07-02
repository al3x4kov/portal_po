import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FsProjectRepo,
  linkInputShape,
  requirementCreateShape,
  requirementUpdateShape,
  type OpLogEntry,
  type OpLogger,
} from '@po/server';
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

  it('S11 link_requirements self-link → SELF_LINK error', async () => {
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

// ARCH-4: the MCP tools consume the canonical @po/server contract shapes so the
// accepted input cannot drift from the REST routes (which use the same objects).
describe('ARCH-4 MCP tools reuse the canonical input contracts', () => {
  it('create/update/link tools reference the exact canonical field validators', async () => {
    const root = await makeTmpRoot();
    try {
      const defs = byName(createTools(root, fixedNow));
      const create = defs.get('create_requirement')!;
      const update = defs.get('update_requirement')!;
      const link = defs.get('link_requirements')!;

      // Reference equality proves a single source of truth (no re-declared fields).
      expect(create.inputSchema.type).toBe(requirementCreateShape.type);
      expect(create.inputSchema.name).toBe(requirementCreateShape.name);
      expect(create.inputSchema.criticality).toBe(requirementCreateShape.criticality);
      expect(update.inputSchema.name).toBe(requirementUpdateShape.name);
      // `type` is immutable on update — the tool must NOT accept it.
      expect(update.inputSchema.type).toBeUndefined();
      expect(link.inputSchema.sourceSlug).toBe(linkInputShape.sourceSlug);
      expect(link.inputSchema.targetSlug).toBe(linkInputShape.targetSlug);
    } finally {
      await cleanup(root);
    }
  });
});

// ARCH-11: domain error details survive into the MCP error result.
describe('ARCH-11 MCP preserves structured error details', () => {
  let root: string;
  let tools: Map<string, ToolDef>;

  beforeEach(async () => {
    root = await makeTmpRoot();
    tools = byName(createTools(root, fixedNow));
    await new FsProjectRepo(root).create('P', fixedNow);
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
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('a CYCLE error carries the offending path in structuredContent', async () => {
    const res = await call(tools, 'link_requirements', {
      projectId: 'P',
      sourceSlug: 'b',
      type: 'PARENT_OF',
      targetSlug: 'a',
    });
    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error?: { code?: string; details?: unknown } })
      ?.error;
    expect(error?.code).toBe('CYCLE');
    const details = error?.details as { path?: unknown } | undefined;
    expect(Array.isArray(details?.path)).toBe(true);
  });

  it('a HAS_CHILDREN error carries the blocking children', async () => {
    const res = await call(tools, 'delete_requirement', { projectId: 'P', slug: 'a' });
    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error?: { code?: string; details?: unknown } })
      ?.error;
    expect(error?.code).toBe('HAS_CHILDREN');
    const details = error?.details as { children?: unknown } | undefined;
    expect(Array.isArray(details?.children)).toBe(true);
  });
});

// ARCH-7: MCP mutations emit structured logs (via the injected logger, which in
// production writes to stderr to keep the stdio JSON-RPC channel clean).
describe('ARCH-7 MCP structured logging', () => {
  it('logs a create operation through the injected logger', async () => {
    const root = await makeTmpRoot();
    try {
      const entries: OpLogEntry[] = [];
      const logger: OpLogger = { op: (e) => entries.push(e) };
      await new FsProjectRepo(root).create('P', fixedNow);
      const tools = byName(createTools(root, fixedNow, logger));

      await call(tools, 'create_requirement', {
        projectId: 'P',
        type: 'FUNCTION',
        name: 'Logged',
        criticality: 'LOW',
        implemented: true,
      });
      const entry = entries.find((e) => e.op === 'create');
      expect(entry).toMatchObject({ op: 'create', projectId: 'P', slug: 'logged', outcome: 'ok' });
    } finally {
      await cleanup(root);
    }
  });
});
