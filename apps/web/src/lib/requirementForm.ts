import { z } from 'zod';
import { requirementSchema } from '@po/core';

/**
 * Form schema reused from core's requirementSchema (same field rules: name
 * 1..200, description <=5000, year 2020..2100, enums) plus the conditional
 * rule from core's validateRequirement: when implemented === false, both
 * targetQuarter and targetYear are required (FR-6).
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
  })
  .superRefine((val, ctx) => {
    if (!val.implemented) {
      if (!val.targetQuarter) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetQuarter'],
          message: 'Обязательно, пока требование не реализовано',
        });
      }
      if (val.targetYear === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetYear'],
          message: 'Обязательно, пока требование не реализовано',
        });
      }
    }
  });

export type RequirementFormValues = z.input<typeof requirementFormSchema>;
