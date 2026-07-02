import matter from 'gray-matter';
import yaml from 'js-yaml';
import { z } from 'zod';
import { ParseError } from '../domain/errors.js';
import { formatZodError } from '../validation/schema.js';

/** OpenSpec project manifest, stored as YAML frontmatter in `openspec/project.md`. */
export interface ProjectManifest {
  name: string;
  schemaVersion: number;
  createdAt: string;
}

/** Current manifest schema version. */
export const SCHEMA_VERSION = 2;

const manifestSchema = z.object({
  name: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().min(1),
});

/**
 * Use js-yaml's JSON_SCHEMA so ISO timestamp strings are preserved verbatim as
 * strings instead of being coerced into Date objects.
 */
const engines = {
  yaml: {
    parse: (input: string): object =>
      (yaml.load(input, { schema: yaml.JSON_SCHEMA }) ?? {}) as object,
    stringify: (obj: object): string => yaml.dump(obj, { schema: yaml.JSON_SCHEMA, lineWidth: -1 }),
  },
};

const BODY =
  'OpenSpec project manifest. The source of truth is the frontmatter above; ' +
  'requirements live under `specs/functions` and `specs/nfr`.';

/** Serialize a project manifest into `openspec/project.md` (frontmatter + note body). */
export function serializeManifest(manifest: ProjectManifest): string {
  return matter.stringify(`\n${BODY}\n`, { ...manifest }, { engines });
}

/**
 * Parse an `openspec/project.md` manifest. Malformed frontmatter or schema
 * violations raise {@link ParseError}.
 */
export function parseManifest(md: string): ProjectManifest {
  let result: matter.GrayMatterFile<string>;
  try {
    result = matter(md, { engines });
  } catch (err) {
    throw new ParseError(`Malformed manifest frontmatter: ${(err as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new ParseError(formatZodError(parsed.error));
  }
  return parsed.data;
}
