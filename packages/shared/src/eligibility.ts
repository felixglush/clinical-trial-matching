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

export const EligibilityAssessmentSchema = z.object({
  inclusion: z.array(CriterionAssessmentSchema),
  exclusion: z.array(CriterionAssessmentSchema),
  overall: OverallEligibilitySchema,
});
export type EligibilityAssessment = z.infer<typeof EligibilityAssessmentSchema>;
