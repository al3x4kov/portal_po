import type { AiExtractedRequirement, Requirement } from '@po/core';
import type { RequirementServicePort } from '../ports.js';
import { aggregateRequirements, renderAggregateEvent } from './aggregate.js';
import type { AggregatedRecord, AiImportRuntime } from './types.js';

export interface AggregateInput {
  extracted: AiExtractedRequirement[];
  structureParentByKey: ReadonlyMap<string, string | null>;
  requirementService: RequirementServicePort;
}

export type AggregateOutcome =
  { ok: true; aggregated: AggregatedRecord[]; existing: Requirement[] } | { ok: false };

/**
 * Stage «aggregate» (progress 80–85). Thin I/O wrapper around the pure
 * {@link aggregateRequirements}: reads the project's current requirements,
 * runs the pure aggregation, and maps its structural events to RU log lines.
 */
export async function runAggregateStage(
  rt: AiImportRuntime,
  input: AggregateInput,
): Promise<AggregateOutcome> {
  rt.job.stage = 'aggregate';
  if (rt.cancelled()) return { ok: false };
  const { requirements: existing } = await input.requirementService.list();

  const { aggregated, events } = aggregateRequirements({
    extracted: input.extracted,
    existing,
    structureParentByKey: input.structureParentByKey,
  });
  for (const event of events) {
    const { level, message } = renderAggregateEvent(event);
    rt.log(level, message);
  }
  rt.job.progress = 85;
  return { ok: true, aggregated, existing };
}
