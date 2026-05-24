import { z } from "zod";
import { EligibilityAssessmentSchema, SafetyConcernSchema } from "./eligibility.js";
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
  // Structured eligibility fields used by pre-filter Stage 1.
  //
  // Age is represented twice on purpose: the raw CT.gov strings power
  // human-readable drop labels ("Age below minimum: 18 Years") while the
  // parsed-at-ingest numerics drive logic. Pre-filter trusts the
  // numerics. See `apps/agent/src/util/ctgov.ts#parseAgeYears` and
  // docs/ctgov-api-shape.md for the unit list.
  minimumAge: z.string().optional(),      // raw CT.gov format, e.g. "18 Years"
  maximumAge: z.string().optional(),
  minimumAgeYears: z.number().nonnegative().optional(),
  maximumAgeYears: z.number().nonnegative().optional(),
  // CT.gov's pre-bucketed age categories. Drives pre-filter's coarse
  // disjointness gate before the numeric compare — protects against
  // unparseable units (e.g. "48 Hours") slipping through.
  //   CHILD       = 0–17
  //   ADULT       = 18–64
  //   OLDER_ADULT = 65+
  stdAges: z.array(z.enum(["CHILD", "ADULT", "OLDER_ADULT"])).default([]),
  sexEligibility: z.enum(["ALL", "MALE", "FEMALE"]).optional(),
  // Provenance. Every candidate is discovered via at least one channel.
  // `repurposingDrugIds` is empty when only the strategy channel surfaced
  // the trial; otherwise contains the `drug.id` values from
  // `state.repurposingCandidates` that produced the hit.
  discoveredVia: z.array(z.enum(["strategy", "repurposing"])).nonempty(),
  repurposingDrugIds: z.array(z.string()),
});
export type TrialCandidate = z.infer<typeof TrialCandidateSchema>;

export const MechanismEvidenceItemSchema = z.object({
  pmid: z.string(),
  quote: z.string(),
  supports: z.enum(["yes", "weak", "no"]),
});
export type MechanismEvidenceItem = z.infer<typeof MechanismEvidenceItemSchema>;

// Mechanism-judging shape (NOT TrialCandidate — counter-evidence doesn't
// carry discovery provenance or eligibility fields). One per prior trial
// of the drug+condition retrieved from CT.gov with status TERMINATED,
// WITHDRAWN, or SUSPENDED. `whyStopped` is raw markup as CT.gov returns
// it; the LLM judges whether the reason is real biomedical
// counter-evidence vs administrative noise.
export const PriorTerminatedTrialSchema = z.object({
  nctId: z.string(),
  briefTitle: z.string(),
  conditions: z.array(z.string()),
  interventions: z.array(z.string()),
  phase: z.string().optional(),
  status: z.enum(["TERMINATED", "WITHDRAWN", "SUSPENDED"]),
  whyStopped: z.string().optional(),
  completionDate: z.string().optional(),
});
export type PriorTerminatedTrial = z.infer<typeof PriorTerminatedTrialSchema>;

// Reuses SafetyConcernSchema from eligibility for primeKgContraindications:
// the row shape (drugId, drugName, conditionId, conditionName, relation)
// is exactly what `findContraindicationsForDrugs` already returns and what
// `eligibility-check` already passes to its LLM. Same field, second consumer.
export const StructuredCounterEvidenceSchema = z.object({
  primeKgContraindications: z.array(SafetyConcernSchema),
  txGnnPredContraindication: z.number().nullable(),
  terminatedPriorTrials: z.array(PriorTerminatedTrialSchema),
});
export type StructuredCounterEvidence = z.infer<typeof StructuredCounterEvidenceSchema>;

export const TrialMatchSchema = TrialCandidateSchema.extend({
  score: z.number().min(0).max(100),
  summary: z.string(),
  eligibility: EligibilityAssessmentSchema,
  mechanismScore: z.number().min(0).max(100),
  mechanismRationale: z.string(),
  literatureSupport: z.array(CitationSchema),
  repurposingRationale: RepurposingRationaleSchema.nullable(),
  concerns: z.array(z.string()),
  mechanismEvidence: z.array(MechanismEvidenceItemSchema).default([]),
  counterEvidenceAddressed: z.string().nullable().default(null),
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
