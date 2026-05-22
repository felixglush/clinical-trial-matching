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
  // NEW: structured eligibility fields used by pre-filter Stage 1.
  minimumAge: z.string().optional(),      // CT.gov format: "18 Years"
  maximumAge: z.string().optional(),
  sexEligibility: z.enum(["ALL", "MALE", "FEMALE"]).optional(),
  // NEW: provenance. Every candidate is discovered via at least one
  // channel. `repurposingDrugIds` is empty when only the strategy channel
  // surfaced the trial; otherwise contains the `drug.id` values from
  // `state.repurposingCandidates` that produced the hit.
  discoveredVia: z.array(z.enum(["strategy", "repurposing"])).nonempty(),
  repurposingDrugIds: z.array(z.string()),
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

// Why a TrialCandidate didn't make it past pre-filter. Mirrors the
// MECHANISM_DROP_REASONS pattern in mechanism.ts — single source of truth
// for the enum, label, and display order. UIs iterate the array; the
// schema and type derive from it.
export const CANDIDATE_DROP_REASONS = [
  { value: "not-recruiting",   label: "Not recruiting" },
  { value: "age-too-young",    label: "Age below minimum" },
  { value: "age-too-old",      label: "Age above maximum" },
  { value: "sex-mismatch",     label: "Sex mismatch" },
  { value: "deceased",         label: "Patient deceased" },
  { value: "llm-ineligible",   label: "LLM judged ineligible" },
] as const;

export type CandidateDropReason = (typeof CANDIDATE_DROP_REASONS)[number]["value"];

export const CandidateDropReasonSchema = z.enum(
  CANDIDATE_DROP_REASONS.map((r) => r.value) as [
    CandidateDropReason,
    ...CandidateDropReason[],
  ],
);

export const CandidateDropSchema = z.object({
  nctId: z.string(),
  title: z.string(),
  reason: CandidateDropReasonSchema,
  detail: z.string().optional(),
  stage: z.enum(["stage1", "stage2"]),
});
export type CandidateDrop = z.infer<typeof CandidateDropSchema>;
