/**
 * # synthesize-match (trial-eval subgraph)
 *
 * Compose the final `TrialMatch`. Four steps:
 *
 *   1. Deterministic formula computes `score` from two pillars
 *      (eligibility, mechanism). Literature is NOT a formula input —
 *      citations are surfaced as artifacts on the TrialMatch and in the
 *      narrate prompt's supporting-evidence block, but count does not
 *      affect ranking. Eligibility-gated: `ineligible → 0`,
 *      `likely_ineligible → min(25, weightedSum)`, otherwise the sum.
 *   2. LLM narrates `summary` + `concerns` given the sub-scores and
 *      structured signals (including citation titles). The LLM does NOT
 *      touch the score.
 *   3. Templated `repurposingRationale` when the candidate came from
 *      the repurposing channel.
 *   4. Assemble the TrialMatch from the candidate, the LLM narration,
 *      and the deterministic components.
 *
 * Contract: ALWAYS returns a TrialMatch — the parent's `matches`
 * concat reducer can't distinguish a missing match from a fanned-out
 * miss. Fallback paths handle LLM failure and null mechanism cleanly.
 *
 * Spec: docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md
 * → synthesize-match (Steps 1–4) + score-formula row.
 */

import type {
  RepurposingCandidate,
  RepurposingRationale,
  TrialMatch,
} from "@clinical-trial-matching/shared";

import { llm } from "../../../llm.js";
import {
  MatchNarrationSchema,
  matchNarrationPrompt,
} from "../../../prompts/match-narration.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const WEIGHT_ELIGIBILITY = 0.6;
const WEIGHT_MECHANISM = 0.4;
const LIKELY_INELIGIBLE_CAP = 25;

const judgeNarration = llm.withStructuredOutput(MatchNarrationSchema);

export async function synthesizeMatch(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const sub = computeSubScores(state);
  const score = gateScore(state.eligibility?.overall, sub.total);

  const repurposingRationale = computeRepurposingRationale(
    state.candidate.repurposingDrugIds,
    state.repurposingCandidates,
  );

  const discoveredViaRepurposing =
    state.candidate.discoveredVia.includes("repurposing");

  let summary: string;
  let concerns: string[];
  try {
    const narration = await judgeNarration.invoke(
      matchNarrationPrompt({
        profile: state.patientProfile,
        candidate: state.candidate,
        eligibility: state.eligibility!,
        mechanismScore: sub.mechanismScore,
        mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
        literatureSupport: state.literatureSupport,
        sub: { ...sub, total: score },
        discoveredViaRepurposing,
      }),
    );
    summary = narration.summary;
    concerns = narration.concerns;
  } catch (err) {
    console.warn(
      `synthesize-match: LLM narrate failed for ${state.candidate.nctId}: ${errorMessage(err)} (templated fallback)`,
    );
    summary = templatedSummary(state, score, sub);
    concerns = deterministicConcerns(state);
  }

  const match: TrialMatch = {
    ...state.candidate,
    score,
    summary,
    eligibility: state.eligibility!,
    mechanismScore: sub.mechanismScore,
    mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
    literatureSupport: state.literatureSupport,
    repurposingRationale,
    concerns,
  };
  // Wrap in a single-element array so the subgraph's `matches` field
  // (concat reducer) propagates back to the parent graph's `matches`
  // field (also concat reducer). The parent appends this branch's
  // [match] to the running list, accumulating across all fan-out
  // branches.
  return { matches: [match] };
}

// ---------- Formula ----------

type SubScores = {
  eligibilityScore: number;
  mechanismScore: number;
  total: number;
};

function computeSubScores(state: TrialEvalStateType): SubScores {
  const eligibilityScore = mapEligibility(state.eligibility?.overall);
  const mechanismScore = state.mechanismScore ?? 50;
  const total = Math.round(
    WEIGHT_ELIGIBILITY * eligibilityScore + WEIGHT_MECHANISM * mechanismScore,
  );
  return { eligibilityScore, mechanismScore, total };
}

function mapEligibility(overall: string | undefined): number {
  switch (overall) {
    case "eligible":
      return 100;
    case "likely_eligible":
      return 75;
    case "unclear":
      return 50;
    case "likely_ineligible":
      return 25;
    case "ineligible":
      return 0;
    default:
      return 50; // null state.eligibility → treat as unclear; defensive
  }
}

function gateScore(overall: string | undefined, weightedSum: number): number {
  if (overall === "ineligible") return 0;
  if (overall === "likely_ineligible") return Math.min(LIKELY_INELIGIBLE_CAP, weightedSum);
  return weightedSum;
}

// ---------- Repurposing rationale ----------

function computeRepurposingRationale(
  drugIds: readonly string[],
  candidates: RepurposingCandidate[],
): RepurposingRationale | null {
  if (drugIds.length === 0) return null;
  const sources = candidates.filter((rc) => drugIds.includes(rc.drug.id));
  if (sources.length === 0) return null;
  const source = sources.reduce((best, c) =>
    (c.predIndication ?? 0) > (best.predIndication ?? 0) ? c : best,
  );
  const score = (source.predIndication ?? 0).toFixed(2);
  const indications = source.originalIndications.join(", ") || "(unknown)";
  return {
    drugName: source.drug.name,
    originalIndications: source.originalIndications,
    summary: `${source.drug.name} is approved for ${indications}; TxGNN predicted it (indication ${score}).`,
  };
}

// ---------- Templated fallbacks ----------

function templatedSummary(
  state: TrialEvalStateType,
  score: number,
  sub: SubScores,
): string {
  const overall = state.eligibility?.overall ?? "unclear";
  const citCount = state.literatureSupport.length;
  return `${state.candidate.title}: eligibility=${overall}, mechanism=${sub.mechanismScore}/100, ${citCount} supporting citation(s); composite score ${score}.`;
}

function deterministicConcerns(state: TrialEvalStateType): string[] {
  const concerns: string[] = [];
  const overall = state.eligibility?.overall;
  if (overall === "ineligible") concerns.push("patient ineligible");
  if (overall === "likely_ineligible") concerns.push("patient likely ineligible");
  if (state.eligibility?.safetyConcerns?.length) {
    for (const s of state.eligibility.safetyConcerns) {
      concerns.push(`${s.relation}: ${s.drugName} vs ${s.conditionName}`);
    }
  }
  if (state.mechanismScore == null) concerns.push("mechanism evaluation unavailable");
  if (state.literatureSupport.length === 0) concerns.push("no PubMed evidence found");
  return concerns;
}
