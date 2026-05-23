/**
 * # prompts/eligibility
 *
 * Per-criterion analysis of CT.gov's free-form inclusion/exclusion text
 * against the patient profile. Returns a structured `EligibilityAssessment`
 * with per-criterion verdicts (`yes`/`no`/`unknown`) and a coarse 5-level
 * `overall` enum.
 *
 * The prompt also receives the deterministic `SafetyConcern[]` from the
 * KG safety step (computed in `eligibility-check` before this prompt
 * runs). When present, the LLM is told to downgrade `overall` if a
 * concern is clinically relevant — the LLM is the judge of relevance,
 * the structured concerns flow through to `TrialMatch.eligibility.safetyConcerns`
 * regardless.
 *
 * CT.gov eligibility text averages ~1.5KB but the long tail reaches
 * several KB. `ELIGIBILITY_FULL_CHARS = 8000` is the truncation cap:
 * doubles `pre-filter`'s coarse cap (4000) to handle the trial-eval
 * fuller pass, while still bounding token cost.
 */

import { z } from "zod";

import {
  isActiveCondition,
  isActiveMedication,
  type PatientProfile,
  type SafetyConcern,
  type TrialCandidate,
} from "@clinical-trial-matching/shared";

export const ELIGIBILITY_FULL_CHARS = 8000;

export const EligibilityJudgmentSchema = z.object({
  inclusion: z.array(
    z.object({
      criterion: z.string(),
      met: z.enum(["yes", "no", "unknown"]),
      evidence: z.string(),
    }),
  ),
  exclusion: z.array(
    z.object({
      criterion: z.string(),
      met: z.enum(["yes", "no", "unknown"]),
      evidence: z.string(),
    }),
  ),
  overall: z.enum([
    "eligible",
    "likely_eligible",
    "unclear",
    "likely_ineligible",
    "ineligible",
  ]),
});
export type EligibilityJudgment = z.infer<typeof EligibilityJudgmentSchema>;

export function eligibilityPrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  safetyConcerns: SafetyConcern[],
): string {
  const conditions = profile.conditions
    .filter(isActiveCondition)
    .map((c) => `  - ${c.display}`)
    .join("\n");
  const meds = profile.medications
    .filter(isActiveMedication)
    .map((m) => `  - ${m.display}`)
    .join("\n");
  const priorTx = profile.priorTreatments.map((p) => `  - ${p.display}`).join("\n");

  const elig = candidate.eligibilityCriteriaText
    ? candidate.eligibilityCriteriaText.slice(0, ELIGIBILITY_FULL_CHARS)
    : "(none)";

  const safetyBlock =
    safetyConcerns.length > 0
      ? [
          "",
          "PrimeKG safety concerns (deterministic; consider when judging overall):",
          ...safetyConcerns.map(
            (c) =>
              `  - ${c.drugName} has a ${c.relation} edge against the patient's ${c.conditionName}.`,
          ),
        ].join("\n")
      : "";

  return [
    "You are evaluating one clinical trial's eligibility against a patient profile.",
    "Walk the inclusion and exclusion criteria one by one, decide yes/no/unknown",
    "for each against the patient, and cite specific evidence from the profile.",
    "Then assign an overall verdict.",
    "",
    "Patient:",
    `  age: ${profile.ageYears}, sex: ${profile.sex}, deceased: ${profile.deceased}`,
    "  active conditions:",
    conditions || "  (none)",
    "  active medications:",
    meds || "  (none)",
    "  prior treatments:",
    priorTx || "  (none)",
    "",
    "Trial:",
    `  title: ${candidate.title}`,
    `  conditions: ${candidate.conditions.join(", ") || "(none)"}`,
    `  interventions: ${candidate.interventions.join(", ") || "(none)"}`,
    "  eligibility criteria (truncated to first " + ELIGIBILITY_FULL_CHARS + " chars):",
    elig,
    safetyBlock,
    "",
    "Return per-criterion arrays for inclusion and exclusion. For each criterion:",
    "  - criterion: the criterion text (paraphrased; one line)",
    "  - met: yes if the patient satisfies it, no if not, unknown if the profile",
    "    doesn't say. For exclusion criteria, 'yes' means the patient HAS the",
    "    excluded property (i.e., the patient is excluded by it).",
    "  - evidence: a short citation from the profile",
    "",
    "Then assign overall:",
    "  - eligible: all inclusion met, no exclusion triggered",
    "  - likely_eligible: most inclusion met, no major exclusion triggered",
    "  - unclear: insufficient profile data to judge",
    "  - likely_ineligible: one or more important criteria fail",
    "  - ineligible: a hard blocker (excluded subpopulation, missing required prior therapy)",
    "",
    "If a safety concern above is clinically relevant, downgrade overall accordingly.",
  ].join("\n");
}
