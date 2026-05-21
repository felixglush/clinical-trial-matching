import { z } from "zod";
import { EligibilityAssessmentSchema } from "./eligibility";
import { CitationSchema } from "./pubmed";
import { RepurposingRationaleSchema } from "./repurposing";

export const TrialLocationSchema = z.object({
  facility: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  status: z.string().optional(),
});
export type TrialLocation = z.infer<typeof TrialLocationSchema>;

export const TrialCandidateSchema = z.object({
  nctId: z.string(),
  title: z.string(),
  briefSummary: z.string().optional(),
  conditions: z.array(z.string()),
  interventions: z.array(z.string()),
  phase: z.string().optional(),
  status: z.string(),
  eligibilityCriteriaText: z.string().optional(),
  locations: z.array(TrialLocationSchema),
});
export type TrialCandidate = z.infer<typeof TrialCandidateSchema>;

export const TrialMatchSchema = TrialCandidateSchema.extend({
  score: z.number().min(0).max(100),
  summary: z.string(),
  eligibility: EligibilityAssessmentSchema,
  mechanismScore: z.number().min(0).max(100),
  mechanismRationale: z.string(),
  literatureSupport: z.array(CitationSchema),
  repurposingRationale: RepurposingRationaleSchema.nullable(),
  concerns: z.array(z.string()),
});
export type TrialMatch = z.infer<typeof TrialMatchSchema>;
