import type {
  InfoItem,
  Link,
  LinkType,
  Requirement,
  RequirementType,
  Scenario,
  ScenarioKeyword,
  SourceEntry,
} from '../domain/types.js';
import { LINK_TYPES, SCENARIO_KEYWORDS } from '../domain/types.js';
import type { ExportOptionalField } from '../domain/exportFields.js';
import { ParseError } from '../domain/errors.js';
import { formatZodError, requirementSchema } from '../validation/schema.js';
import { checkTargetRule } from '../validation/targetRule.js';

/**
 * Context that a requirement's markdown file does NOT carry inline: the `slug`
 * comes from the file name and the `type` from the containing folder
 * (`openspec/specs/functions` | `openspec/specs/nfr`), per ADR-001.
 */
export interface ParseContext {
  slug: string;
  type: RequirementType;
  /**
   * Default project priorityId used to migrate a legacy `source:string` into
   * `sources[0]` (TEXT) when the file carries no explicit sources (todo_19
   * §0.4 / T-105). When omitted, a legacy `source` is left as-is (pure
   * round-trip: no migration side effect).
   */
  defaultPriorityId?: string;
}

const META_KEYS = [
  'criticality',
  'implemented',
  'target',
  'createdAt',
  'updatedAt',
  'source',
  'releaseDate',
  'origin',
  'aiValidated',
] as const;
const HEADER_RE = /^###\s+Requirement:\s*(.+?)\s*$/;
const META_RE = /^-\s+(\w+):\s*(.*)$/;
const SCENARIO_RE = /^####\s+Scenario:\s*(.+?)\s*$/;
const LINKS_RE = /^####\s+Links\s*$/;
const SOURCES_RE = /^####\s+Sources\s*$/;
const INFO_RE = /^####\s+Info\s*$/;
const STEP_RE = /^-\s+(GIVEN|WHEN|THEN|AND)\s+(.*)$/;
const LINK_RE = /^-\s+(\w+):\s*(.+?)\s*$/;
const INFO_ITEM_RE = /^-\s+(.+?):\s+(.*)$/;
const TARGET_RE = /^Q([1-4])\s+(\d{4})$/;

/** Options controlling which optional sections {@link serialize} emits. */
export interface SerializeOptions {
  /**
   * Optional fields to include (Task 2 export selection). A section is written
   * ⇔ its field is present here AND the value is non-empty. Mandatory data
   * (header, criticality, implemented(+target), createdAt/updatedAt) is always
   * written. `undefined` (or omitting `opts` entirely) includes everything, so
   * the output is byte-for-byte identical to the unmasked serialize.
   */
  fields?: ExportOptionalField[];
}

/**
 * Serialize a Requirement into an OpenSpec `.md` document (ADR-001 §3):
 * `### Requirement:` header, metadata bullets, markdown body, optional
 * `#### Scenario:` blocks and a `#### Links` section. `slug`/`type` are NOT
 * emitted — they live in the file name and folder respectively.
 *
 * Passing `opts.fields` masks the optional sections (Task 2). `description`
 * governs both the body and the `#### Scenario:` blocks; `info` → `#### Info`;
 * `links` → `#### Links`; `source` → the `- source:` bullet. Without `opts`
 * (or with `fields === undefined`) the result is unchanged.
 */
export function serialize(req: Requirement, opts?: SerializeOptions): string {
  const fields = opts?.fields;
  const has = (field: ExportOptionalField): boolean =>
    fields === undefined || fields.includes(field);

  const lines: string[] = [];
  lines.push(`### Requirement: ${req.name}`);
  lines.push(`- criticality: ${req.criticality}`);
  lines.push(`- implemented: ${String(req.implemented)}`);
  if (!req.implemented && req.targetQuarter && req.targetYear !== undefined) {
    lines.push(`- target: ${req.targetQuarter} ${String(req.targetYear)}`);
  }
  if (!req.implemented && req.releaseDate !== undefined) {
    lines.push(`- releaseDate: ${req.releaseDate}`);
  }
  lines.push(`- createdAt: ${req.createdAt}`);
  lines.push(`- updatedAt: ${req.updatedAt}`);
  if (has('source') && req.source !== undefined) {
    lines.push(`- source: ${req.source}`);
  }
  // task26 provenance: always written (never part of the export field mask) —
  // it is metadata of the record itself, like createdAt/updatedAt.
  if (req.origin !== undefined) {
    lines.push(`- origin: ${req.origin}`);
  }
  if (req.aiValidated !== undefined) {
    lines.push(`- aiValidated: ${String(req.aiValidated)}`);
  }

  if (has('description') && req.description !== undefined && req.description.length > 0) {
    lines.push('');
    lines.push(req.description);
  }

  if (has('description')) {
    for (const scenario of req.scenarios ?? []) {
      lines.push('');
      lines.push(`#### Scenario: ${scenario.name}`);
      for (const step of scenario.steps) {
        lines.push(`- ${step.keyword} ${step.text}`);
      }
    }
  }

  if (req.sources && req.sources.length > 0) {
    lines.push('');
    lines.push('#### Sources');
    for (const s of req.sources) {
      lines.push(`- ${JSON.stringify(s)}`);
    }
  }

  if (has('links') && req.links.length > 0) {
    lines.push('');
    lines.push('#### Links');
    for (const l of req.links) {
      lines.push(`- ${l.type}: ${l.targetSlug}`);
    }
  }

  if (has('info') && req.infoItems && req.infoItems.length > 0) {
    lines.push('');
    lines.push('#### Info');
    for (const item of req.infoItems) {
      lines.push(`- ${item.type}: ${item.value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function parseBool(raw: string | undefined): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ParseError(
    `Invalid "implemented" value: "${raw ?? '(missing)'}" (expected true|false).`,
  );
}

/**
 * Parse an OpenSpec `.md` document back into a validated Requirement.
 * A malformed document (missing header, bad metadata, schema/rule violation)
 * raises {@link ParseError} — never an uncaught exception — so callers can flag
 * broken files without aborting a project load.
 */
export function parse(md: string, ctx: ParseContext): Requirement {
  const lines = md.replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;

  const header = HEADER_RE.exec(lines[i] ?? '');
  if (!header) {
    throw new ParseError('Missing "### Requirement: <name>" header.');
  }
  const name = header[1]!;
  i += 1;

  // Metadata bullets directly under the header (contiguous block).
  const meta: Record<string, string> = {};
  while (i < lines.length) {
    const m = META_RE.exec(lines[i]!);
    if (!m || !(META_KEYS as readonly string[]).includes(m[1]!)) break;
    meta[m[1]!] = m[2]!.trim();
    i += 1;
  }

  const descLines: string[] = [];
  const scenarios: Scenario[] = [];
  const links: Link[] = [];
  const infoItems: InfoItem[] = [];
  const sources: SourceEntry[] = [];
  let mode: 'desc' | 'scenario' | 'links' | 'info' | 'sources' = 'desc';
  let current: Scenario | null = null;

  for (const line of lines.slice(i)) {
    const scenarioMatch = SCENARIO_RE.exec(line);
    if (scenarioMatch) {
      current = { name: scenarioMatch[1]!, steps: [] };
      scenarios.push(current);
      mode = 'scenario';
      continue;
    }
    if (SOURCES_RE.test(line)) {
      mode = 'sources';
      current = null;
      continue;
    }
    if (LINKS_RE.test(line)) {
      mode = 'links';
      current = null;
      continue;
    }
    if (INFO_RE.test(line)) {
      mode = 'info';
      current = null;
      continue;
    }
    if (mode === 'desc') {
      descLines.push(line);
      continue;
    }
    if (mode === 'scenario') {
      const step = STEP_RE.exec(line);
      if (step && current) {
        current.steps.push({ keyword: step[1] as ScenarioKeyword, text: step[2]!.trim() });
      }
      continue;
    }
    if (mode === 'links') {
      const link = LINK_RE.exec(line);
      if (link) {
        const type = link[1]!;
        if (!(LINK_TYPES as readonly string[]).includes(type)) {
          throw new ParseError(`Unknown link type "${type}".`);
        }
        links.push({ type: type as LinkType, targetSlug: link[2]!.trim() });
      }
      continue;
    }
    if (mode === 'sources') {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const jsonMatch = /^-\s+(.*)$/.exec(trimmed);
      if (!jsonMatch) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(jsonMatch[1]!);
      } catch {
        throw new ParseError(`Malformed source entry: "${jsonMatch[1]!}".`);
      }
      sources.push(raw as SourceEntry);
      continue;
    }
    // mode === 'info': tolerant — skip lines that don't match INFO_ITEM_RE
    const infoItem = INFO_ITEM_RE.exec(line);
    if (infoItem) {
      infoItems.push({ type: infoItem[1]!.trim(), value: infoItem[2]!.trim() });
    }
  }

  const description = descLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');

  const candidate: Record<string, unknown> = {
    slug: ctx.slug,
    type: ctx.type,
    name,
    criticality: meta.criticality,
    implemented: parseBool(meta.implemented),
    links,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
  if (description.length > 0) candidate.description = description;
  if (scenarios.length > 0) candidate.scenarios = scenarios;
  if (meta.source !== undefined && meta.source.trim().length > 0) {
    candidate.source = meta.source.trim();
  }
  if (infoItems.length > 0) candidate.infoItems = infoItems;
  if (sources.length > 0) candidate.sources = sources;
  if (meta.releaseDate !== undefined && meta.releaseDate.trim().length > 0) {
    candidate.releaseDate = meta.releaseDate.trim();
  }
  // task26: absent bullets ⇒ human-made (every pre-task26 file reads that way).
  if (meta.origin !== undefined && meta.origin.trim().length > 0) {
    candidate.origin = meta.origin.trim();
  }
  if (meta.aiValidated !== undefined && meta.aiValidated.trim().length > 0) {
    const raw = meta.aiValidated.trim();
    if (raw !== 'true' && raw !== 'false') {
      throw new ParseError(`Invalid "aiValidated" value: "${raw}" (expected true|false).`);
    }
    candidate.aiValidated = raw === 'true';
  }

  // Migration (T-105): a legacy `source:string` with no explicit sources becomes
  // a single TEXT source carrying the project's default priority. Only runs when
  // the caller supplies a default priorityId (repository read path).
  if (
    candidate.sources === undefined &&
    typeof candidate.source === 'string' &&
    ctx.defaultPriorityId !== undefined
  ) {
    candidate.sources = [
      { type: 'TEXT', name: candidate.source, priorityId: ctx.defaultPriorityId },
    ];
    delete candidate.source;
  }
  if (meta.target !== undefined) {
    const t = TARGET_RE.exec(meta.target);
    if (!t) {
      throw new ParseError(`Invalid "target" value: "${meta.target}" (expected "Q<1-4> <year>").`);
    }
    candidate.targetQuarter = `Q${t[1]}`;
    candidate.targetYear = Number(t[2]);
  }

  const parsed = requirementSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ParseError(formatZodError(parsed.error));
  }
  const req = parsed.data;

  // Conditional target rule (2.4, BE-2): required iff not implemented, forbidden otherwise.
  const violation = checkTargetRule(req);
  if (violation?.kind === 'unexpected-target') {
    throw new ParseError('An implemented requirement must not carry a target.');
  }
  if (violation?.kind === 'missing-target') {
    throw new ParseError('A not-implemented requirement requires a target (quarter and year).');
  }

  return req;
}

/** True when a scenario is complete (has at least a WHEN and a THEN step). */
export function isScenarioComplete(scenario: Scenario): boolean {
  const kinds = new Set<ScenarioKeyword>(scenario.steps.map((s) => s.keyword));
  return kinds.has('WHEN') && kinds.has('THEN');
}

/** Names of incomplete scenarios on a requirement (warn flag for S6). */
export function incompleteScenarios(req: Requirement): string[] {
  return (req.scenarios ?? []).filter((s) => !isScenarioComplete(s)).map((s) => s.name);
}

/** Re-exported for tests that assert against the canonical keyword list. */
export { SCENARIO_KEYWORDS };
