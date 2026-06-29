import matter from 'gray-matter';
import yaml from 'js-yaml';
import type { Requirement } from '../domain/types.js';
import { ParseError } from '../domain/errors.js';
import { formatZodError, requirementSchema } from '../validation/schema.js';

/**
 * Use js-yaml's JSON_SCHEMA so ISO timestamp strings (createdAt/updatedAt) are
 * preserved verbatim as strings instead of being coerced into Date objects.
 */
const engines = {
  yaml: {
    parse: (input: string): object =>
      (yaml.load(input, { schema: yaml.JSON_SCHEMA }) ?? {}) as object,
    stringify: (obj: object): string => yaml.dump(obj, { schema: yaml.JSON_SCHEMA, lineWidth: -1 }),
  },
};

/** Serialize a Requirement into a machine-readable `.md` (YAML frontmatter + body). */
export function serialize(req: Requirement): string {
  const data: Record<string, unknown> = {
    id: req.id,
    type: req.type,
    name: req.name,
    criticality: req.criticality,
    implemented: req.implemented,
  };
  if (req.targetQuarter !== undefined) data.targetQuarter = req.targetQuarter;
  if (req.targetYear !== undefined) data.targetYear = req.targetYear;
  data.links = req.links;
  data.createdAt = req.createdAt;
  data.updatedAt = req.updatedAt;

  return matter.stringify(req.description ?? '', data, { engines });
}

function normalizeBody(body: string): string | undefined {
  const trimmed = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse a `.md` document back into a validated Requirement.
 * Malformed frontmatter or schema violations raise {@link ParseError}
 * (never an uncaught runtime exception), so callers can flag broken files.
 */
export function parse(md: string): Requirement {
  let result: matter.GrayMatterFile<string>;
  try {
    result = matter(md, { engines });
  } catch (err) {
    throw new ParseError(`Malformed frontmatter: ${(err as Error).message}`);
  }

  const description = normalizeBody(result.content);
  const candidate: Record<string, unknown> = { ...result.data };
  if (description !== undefined) {
    candidate.description = description;
  }

  const parsed = requirementSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ParseError(formatZodError(parsed.error));
  }
  return parsed.data;
}
