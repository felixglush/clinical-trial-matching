import { z } from "zod";

export const CriterionVerdictSchema = z.enum(["yes", "no", "unknown"]);
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

export const CriterionAssessmentSchema = z.object({
  criterion: z.string(),
  met: CriterionVerdictSchema,
  evidence: z.string(),
});
export type CriterionAssessment = z.infer<typeof CriterionAssessmentSchema>;

export const OverallEligibilitySchema = z.enum([
  "eligible",
  "likely_eligible",
  "unclear",
  "likely_ineligible",
  "ineligible",
]);
export type OverallEligibility = z.infer<typeof OverallEligibilitySchema>;

// Surfaces from the deterministic PrimeKG safety step inside
// `eligibility-check`: each entry represents a `drug -[:contraindication]-
// disease` edge between a trial intervention and an active patient
// condition. `relation` is a single-element enum because the PrimeKG
// subset (per `pnpm kg:build-subset`) dropped `side_effect` nodes/edges;
// the enum is shaped to extend later without breaking consumers.
export const SafetyConcernSchema = z.object({
  drugId: z.string(),
  drugName: z.string(),
  conditionId: z.string(),
  conditionName: z.string(),
  relation: z.enum(["contraindication"]),
});
export type SafetyConcern = z.infer<typeof SafetyConcernSchema>;

export const EligibilityAssessmentSchema = z.object({
  inclusion: z.array(CriterionAssessmentSchema),
  exclusion: z.array(CriterionAssessmentSchema),
  overall: OverallEligibilitySchema,
  safetyConcerns: z.array(SafetyConcernSchema).default([]),
});
export type EligibilityAssessment = z.infer<typeof EligibilityAssessmentSchema>;
