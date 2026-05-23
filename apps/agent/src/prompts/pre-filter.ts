/**
 * # prompts/pre-filter
 *
 * Stage-2 prompt for `nodes/pre-filter.ts`. Produces a `keep / drop`
 * judgment per surviving candidate. Stage 1 (deterministic gates) is
 * handled in the node directly — this prompt only sees candidates that
 * already passed status, age, sex, and deceased checks.
 *
 * The instruction "when in doubt, KEEP" is load-bearing. False-positives
 * here (keeping a trial that turns out ineligible) are cheap — the
 * expensive `trial-eval` eligibility node runs per-criterion analysis
 * downstream and catches them. False-negatives (dropping a trial that
 * should have advanced) are expensive — they vanish from the run.
 *
 * Eligibility criteria from CT.gov can run several KB. We truncate to
 * `ELIGIBILITY_EXCERPT_CHARS` for the prompt; `trial-eval` reads the
 * full text from `state.candidates` so truncation only affects this
 * stage's coarse judgment.
 */

import { z } from "zod";

import {
  isActiveCondition,
  isActiveMedication,
  type PatientProfile,
  type TrialCandidate,
} from "@clinical-trial-matching/shared";

// Sampled from 200 real CT.gov studies: p50 length 825 chars, p75 1597,
// p90 3172. The Exclusion section (where the prompt's "obvious blocker"
// signals live) starts after 2000 chars in ~4% of trials; raising to
// 4000 cuts that to ~1%. Trade is +~500 tokens for the long tail; Haiku
// makes that trivial. Past 4000 the curve flattens.
export const ELIGIBILITY_EXCERPT_CHARS = 4000;

export const PreFilterJudgmentSchema = z.object({
  keep: z.boolean(),
  reason: z.string(),
});

export function preFilterPrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
): string {
  const conditions = profile.conditions
    .filter(isActiveCondition)
    .map((c) => c.display)
    .join(", ");
  const meds = profile.medications
    .filter(isActiveMedication)
    .map((m) => m.display)
    .join(", ");
  const priorTx = profile.priorTreatments.map((p) => p.display).join(", ");

  const elig = candidate.eligibilityCriteriaText
    ? candidate.eligibilityCriteriaText.slice(0, ELIGIBILITY_EXCERPT_CHARS)
    : "(none)";

  return `You're triaging a clinical trial against a patient profile. Drop the trial
ONLY if there's an obvious eligibility blocker visible in the brief
eligibility text. When in doubt, KEEP — a downstream expensive eligibility
checker will analyze in detail.

Patient:
  - age ${profile.ageYears}, sex ${profile.sex}
  - active conditions: ${conditions || "(none)"}
  - active medications: ${meds || "(none)"}
  - prior treatments: ${priorTx || "(none)"}

Trial:
  - title: ${candidate.title}
  - conditions: ${candidate.conditions.join(", ") || "(none)"}
  - interventions: ${candidate.interventions.join(", ") || "(none)"}
  - eligibility criteria (excerpt, first ${ELIGIBILITY_EXCERPT_CHARS} chars):
    ${elig}

Return keep=true unless one of these is clear from the text above:
  - patient lacks a required prior therapy
  - patient has an excluded condition or excluded prior therapy
  - patient is in an excluded subpopulation (e.g. pregnant, organ failure)

reason: short phrase explaining the call. Empty string if keep=true.`;
}
