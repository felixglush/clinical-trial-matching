/**
 * # synthesize-match (trial-eval subgraph)
 *
 * Compose the final `TrialMatch`. Steps:
 *
 *   1. Deterministic formula computes `score` from two pillars
 *      (eligibility, mechanism). Literature is NOT a formula input —
 *      citations are surfaced as artifacts on the TrialMatch but their
 *      count does not affect ranking. Eligibility-gated: `ineligible → 0`,
 *      `likely_ineligible → min(25, weightedSum)`, otherwise the sum.
 *   2. LLM narrates `summary` + `concerns` given the sub-scores and the
 *      mechanism rationale (which itself cites supporting papers).
 *      `discoveredViaRepurposing` flows into the narration prompt so the
 *      prose can reference the discovery channel.
 *   3. PMID-echo filter on `state.mechanismEvidence`: drop any entry
 *      whose `pmid` is not present in `literatureSupport`.
 *      This guards against the mechanism judge hallucinating PMIDs.
 *   4. Universal Path B-shaped concerns: counter-evidence unaddressed,
 *      and no literature-cited evidence. Both run for every candidate
 *      because the unified mechanism judge populates the relevant state
 *      regardless of discovery channel (previously these were gated on
 *      `!discoveredViaRepurposing`, which silently suppressed concerns
 *      whenever Path B ran on a repurposing-tagged candidate).
 *   5. Templated `repurposingRationale` when the candidate came from
 *      the repurposing channel.
 *   6. Assemble the TrialMatch.
 *
 * Contract: ALWAYS returns a TrialMatch — the parent's `matches`
 * concat reducer can't distinguish a missing match from a fanned-out
 * miss. Fallback paths handle LLM failure and null mechanism cleanly.
 *
 * Spec: docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md
 * → synthesize-match (Steps 1–4) + score-formula row.
 *
 * After the counter-evidence redesign (Task 9):
 *   - PMID-echo set uses `literatureSupport` only — structured
 *     counter-evidence has no PMIDs.
 *   - "Counter-evidence unaddressed" concern fires when ANY non-empty
 *     sub-field of `structuredCounterEvidence` is present.
 */

import type {
  EligibilityAssessment,
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
  const score = gateScore(state.eligibility.overall, sub.total);

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
        eligibility: state.eligibility,
        mechanismScore: sub.mechanismScore,
        mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
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

  // PMID-echo filter: only keep mechanismEvidence entries whose pmid was
  // actually retrieved in literatureSupport. Guards against the mechanism
  // judge hallucinating PMIDs.
  // PMID-echo set is supporting-literature only — structured
  // counter-evidence has no PMIDs and `mechanismEvidence` legitimately
  // only draws from supporting citations after the counter-evidence
  // redesign.
  const knownPmids = new Set<string>(
    state.literatureSupport.map((c) => c.pmid),
  );
  const filteredEvidence = state.mechanismEvidence.filter((e) => {
    const ok = knownPmids.has(e.pmid);
    if (!ok) {
      console.warn(
        `synthesize-match: dropping mechanismEvidence with unknown pmid=${e.pmid} (not in literatureSupport)`,
      );
    }
    return ok;
  });

  // The unified mechanism judge populates `mechanismEvidence` and
  // `counterEvidenceAddressed` for every candidate (regardless of
  // discovery channel), so these concerns now run universally. Both are
  // also accurate when the judge LLM failed and we fell back to a
  // TxGNN-only score: in that degraded mode there is genuinely no
  // literature-cited evidence backing the score, and any retrieved
  // counter-evidence was genuinely not addressed.
  const sce = state.structuredCounterEvidence;
  const hasStructuredCounterEvidence =
    sce.primeKgContraindications.length > 0 ||
    (sce.txGnnPredContraindication !== null && sce.txGnnPredContraindication > 0) ||
    sce.terminatedPriorTrials.length > 0;
  if (hasStructuredCounterEvidence && !state.counterEvidenceAddressed) {
    concerns.push("counter-evidence present but not addressed in mechanism judgment");
  }
  if (filteredEvidence.length === 0 && state.mechanismScore !== null) {
    concerns.push("no literature-cited evidence for mechanism");
  }

  const match: TrialMatch = {
    ...state.candidate,
    score,
    summary,
    eligibility: state.eligibility,
    mechanismScore: sub.mechanismScore,
    mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
    literatureSupport: state.literatureSupport,
    repurposingRationale,
    concerns,
    mechanismEvidence: filteredEvidence,
    counterEvidenceAddressed: state.counterEvidenceAddressed,
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
  const eligibilityScore = mapEligibility(state.eligibility.overall);
  const mechanismScore = state.mechanismScore ?? 50;
  const total = Math.round(
    WEIGHT_ELIGIBILITY * eligibilityScore + WEIGHT_MECHANISM * mechanismScore,
  );
  return { eligibilityScore, mechanismScore, total };
}

function mapEligibility(overall: EligibilityAssessment["overall"]): number {
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
  }
}

function gateScore(
  overall: EligibilityAssessment["overall"],
  weightedSum: number,
): number {
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
  const citCount = state.literatureSupport.length;
  return `${state.candidate.title}: eligibility=${state.eligibility.overall}, mechanism=${sub.mechanismScore}/100, ${citCount} supporting citation(s); composite score ${score}.`;
}

function deterministicConcerns(state: TrialEvalStateType): string[] {
  const concerns: string[] = [];
  const { overall, safetyConcerns } = state.eligibility;
  if (overall === "ineligible") concerns.push("patient ineligible");
  if (overall === "likely_ineligible") concerns.push("patient likely ineligible");
  for (const s of safetyConcerns) {
    concerns.push(`${s.relation}: ${s.drugName} vs ${s.conditionName}`);
  }
  if (state.mechanismScore == null) concerns.push("mechanism evaluation unavailable");
  if (state.literatureSupport.length === 0) concerns.push("no PubMed evidence found");
  return concerns;
}
