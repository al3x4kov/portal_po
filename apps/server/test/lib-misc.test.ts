import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '@po/core';
import { parseInput } from '../src/lib/parseInput.js';
import { sanitizeProjectName } from '../src/lib/projectName.js';
import {
  pinoOpLogger,
  stderrOpLogger,
  withOpLog,
  type OpLogEntry,
  type OpLogger,
} from '../src/lib/logger.js';

/** ARC-T4: micro-branches of the shared server/lib helpers. */

describe('ARC-T4 parseInput', () => {
  const schema = z.object({ id: z.string().min(1) });

  it('returns the parsed data for valid input', () => {
    expect(parseInput(schema, { id: 'p1' })).toEqual({ id: 'p1' });
  });

  it('throws a domain ValidationError (422) with a formatted message for invalid input', () => {
    expect(() => parseInput(schema, { id: '' })).toThrow(ValidationError);
    try {
      parseInput(schema, { id: 42 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      // The zod issue is formatted with its path so clients can locate the field.
      expect((err as ValidationError).message).toContain('id');
      expect((err as ValidationError).code).toBe('VALIDATION');
    }
  });

  it('rejects a completely non-object payload', () => {
    expect(() => parseInput(schema, 'not-an-object')).toThrow(ValidationError);
    expect(() => parseInput(schema, undefined)).toThrow(ValidationError);
  });
});

describe('ARC-T4 sanitizeProjectName', () => {
  it('strips reserved / control characters and surrounding dots/spaces', () => {
    expect(sanitizeProjectName('  My: Pro/ject?*  ')).toBe('My Project');
    expect(sanitizeProjectName('a' + String.fromCharCode(0, 7) + 'bc')).toBe('abc');
    expect(sanitizeProjectName('...name...')).toBe('name');
  });

  it('enforces the length bound', () => {
    const long = 'p'.repeat(500);
    expect(sanitizeProjectName(long).length).toBeLessThanOrEqual(200);
  });

  it('throws ValidationError when nothing safe remains', () => {
    expect(() => sanitizeProjectName('///')).toThrow(ValidationError);
    expect(() => sanitizeProjectName('   ')).toThrow(ValidationError);
    expect(() => sanitizeProjectName('..')).toThrow(ValidationError);
  });
});

describe('ARC-T4 logger (withOpLog / pinoOpLogger / stderrOpLogger)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function collectingLogger(): { entries: OpLogEntry[]; log: OpLogger } {
    const entries: OpLogEntry[] = [];
    return { entries, log: { op: (e) => entries.push(e) } };
  }

  it('withOpLog is a passthrough when no logger is injected', async () => {
    await expect(
      withOpLog(undefined, { op: 'create', projectId: 'P' }, async () => 42),
    ).resolves.toBe(42);
  });

  it('withOpLog logs ok with a slug derived from the result', async () => {
    const { entries, log } = collectingLogger();
    const result = await withOpLog(
      log,
      { op: 'create', projectId: 'P' },
      async () => ({ slug: 'new-slug' }),
      (r) => r.slug,
    );
    expect(result.slug).toBe('new-slug');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      op: 'create',
      projectId: 'P',
      slug: 'new-slug',
      outcome: 'ok',
    });
    expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('withOpLog logs error with the domain code and rethrows', async () => {
    const { entries, log } = collectingLogger();
    const boom = Object.assign(new Error('nope'), { code: 'CYCLE' });
    await expect(
      withOpLog(log, { op: 'link', projectId: 'P', slug: 's' }, async () => {
        throw boom;
      }),
    ).rejects.toThrow('nope');
    expect(entries[0]).toMatchObject({ op: 'link', outcome: 'error', code: 'CYCLE', slug: 's' });
  });

  it('withOpLog omits the code when the throwable has no string code', async () => {
    const { entries, log } = collectingLogger();
    await expect(
      withOpLog(log, { op: 'update', projectId: 'P' }, async () => {
        throw new Error('plain');
      }),
    ).rejects.toThrow('plain');
    expect(entries[0]!.code).toBeUndefined();
  });

  it('pinoOpLogger routes ok → info and error → warn with the fs.op tag', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const log = pinoOpLogger({ info, warn });
    log.op({ op: 'create', projectId: 'P', outcome: 'ok' });
    log.op({ op: 'delete', projectId: 'P', outcome: 'error', code: 'NOT_FOUND' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }), 'fs.op');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }), 'fs.op');
  });

  it('stderrOpLogger writes one JSON line per entry to stderr (never stdout)', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = stderrOpLogger();
    log.op({ op: 'import', projectId: 'P', outcome: 'ok', durationMs: 5 });
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0]![0] as string;
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ op: 'import', projectId: 'P', outcome: 'ok', durationMs: 5 });
    expect(typeof parsed.at).toBe('string');
  });
});
