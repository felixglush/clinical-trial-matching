/**
 * # prompts/match-narration
 *
 * Narration prompt for `synthesize-match`. The LLM does NOT touch the
 * score — that's the deterministic formula's job (eligibility-gated
 * 0.6·E + 0.4·M; literature is not a formula input). The LLM receives
 * the computed score, the two sub-scores, and the structured signals,
 * and returns a 2-3 sentence `summary` plus a structured `concerns`
 * array. The mechanism rationale (from Task 5's literature-grounded
 * judgment) already cites supporting papers inline — we do not also
 * surface a separate supporting-literature block in this prompt to
 * avoid duplicating citations and prevent the narrator from inventing
 * claims off titles it cannot read.
 */

import { z } from "zod";

import type {
  EligibilityAssessment,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

export const MatchNarrationSchema = z.object({
  summary: z.string(),
  concerns: z.array(z.string()),
});
export type MatchNarration = z.infer<typeof MatchNarrationSchema>;

export type MatchNarrationInput = {
  profile: PatientProfile;
  candidate: TrialCandidate;
  eligibility: EligibilityAssessment;
  mechanismScore: number;
  mechanismRationale: string;
  sub: {
    eligibilityScore: number;
    mechanismScore: number;
    total: number;
  };
  discoveredViaRepurposing: boolean;
};

const MAX_CRITERIA_PREVIEW = 3;

export function matchNarrationPrompt(input: MatchNarrationInput): string {
  const {
    profile,
    candidate,
    eligibility,
    mechanismScore,
    mechanismRationale,
    sub,
    discoveredViaRepurposing,
  } = input;

  const failedInclusion = eligibility.inclusion
    .filter((c) => c.met === "no")
    .slice(0, MAX_CRITERIA_PREVIEW);
  const triggeredExclusion = eligibility.exclusion
    .filter((c) => c.met === "yes")
    .slice(0, MAX_CRITERIA_PREVIEW);

  return [
    "Write a brief clinical summary and structured concerns for a trial-patient match.",
    "DO NOT produce a score — it's already computed; you narrate it.",
    "",
    `Patient: ${profile.ageYears}yo ${profile.sex}`,
    "",
    `Trial: ${candidate.title} (${candidate.nctId})`,
    `  conditions: ${candidate.conditions.join(", ") || "(none)"}`,
    `  interventions: ${candidate.interventions.join(", ") || "(none)"}`,
    discoveredViaRepurposing
      ? "  discovery channel: repurposing (TxGNN-predicted intervention for this patient's disease)"
      : "  discovery channel: strategy (mechanism keyword match)",
    "",
    "Sub-scores (deterministic; literature is NOT a score input):",
    `  eligibility: ${sub.eligibilityScore}/100`,
    `  mechanism:   ${sub.mechanismScore}/100`,
    `  total:       ${sub.total}/100  (= round(0.6·eligibility + 0.4·mechanism), then eligibility-gated)`,
    "",
    `Eligibility verdict: ${eligibility.overall}`,
    failedInclusion.length > 0
      ? "  inclusion criteria the patient does NOT meet:\n" +
        failedInclusion.map((c) => `    - ${c.criterion} (${c.evidence})`).join("\n")
      : "  (no failed inclusion criteria in the prompt window)",
    triggeredExclusion.length > 0
      ? "  exclusion criteria triggered by the patient:\n" +
        triggeredExclusion.map((c) => `    - ${c.criterion} (${c.evidence})`).join("\n")
      : "  (no triggered exclusions in the prompt window)",
    eligibility.safetyConcerns.length > 0
      ? "  safety concerns:\n" +
        eligibility.safetyConcerns
          .map((s) => `    - ${s.relation}: ${s.drugName} vs ${s.conditionName}`)
          .join("\n")
      : "",
    "",
    `Mechanism: ${mechanismScore}/100 — ${mechanismRationale}`,
    "",
    "Return:",
    "  - summary: 2-3 sentences describing the match for a clinician reviewer.",
    "    Reference the sub-scores, the eligibility verdict, and the mechanism",
    "    rationale. Do not invent paper titles or PubMed IDs — the mechanism",
    "    rationale already cites the relevant papers. Do not repeat the",
    "    total verbatim.",
    "  - concerns: a list of explicit red flags. Examples: 'patient ineligible',",
    "    'contraindication with X', 'mechanism evaluation unavailable',",
    "    'no PubMed evidence found'. Empty array if no concerns.",
  ].filter((l) => l !== "").join("\n");
}
