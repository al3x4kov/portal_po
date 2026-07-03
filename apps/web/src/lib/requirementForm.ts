import { z } from 'zod';
import { checkTargetRule, requirementSchema } from '@po/core';

/**
 * Form schema reused from core's requirementSchema (same field rules: name
 * 1..200, description <=5000, year 2020..2100, enums) plus the conditional
 * rule from core's validateRequirement: when implemented === false, both
 * targetQuarter and targetYear are required (FR-6).
 * Also includes source (FR-19) and infoItems (FR-20).
 */
export const requirementFormSchema = requirementSchema
  .pick({
    type: true,
    name: true,
    criticality: true,
    description: true,
    implemented: true,
    targetQuarter: true,
    targetYear: true,
    source: true,
    infoItems: true,
  })
  .superRefine((val, ctx) => {
    // Reuse the shared implemented ⟺ target predicate from core (BE-2).
    const violation = checkTargetRule(val);
    if (violation?.kind === 'missing-target') {
      for (const field of violation.fields) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Обязательно, пока требование не реализовано',
        });
      }
    }
  });

export type RequirementFormValues = z.input<typeof requirementFormSchema>;
