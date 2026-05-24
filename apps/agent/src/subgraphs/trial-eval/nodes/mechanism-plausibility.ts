/**
 * # mechanism-plausibility (trial-eval subgraph)
 *
 * Unified plausibility judge: given a candidate, the LLM scores how
 * plausibly the trial's intervention(s) address the patient's mechanism,
 * integrating up to three signal sources — each labeled with provenance
 * in the prompt:
 *
 *   - KG paths from `kg.pathBetween` (PrimeKG, mechanism-relevant edges).
 *   - Tiered PubMed literature (supporting + counter-evidence).
 *   - TxGNN repurposing prediction (only when a matching
 *     `RepurposingCandidate` is in state — i.e. the candidate was surfaced
 *     through the repurposing channel and search-trials' construction
 *     invariant held).
 *
 * The previous two-path design (LLM-free Path A for repurposing,
 * LLM-judged Path B for strategy) was replaced because Path A discarded
 * the literature signal even when literature-support had retrieved
 * citations, and synthesize-match had to gate Path B-only concerns on
 * the channel — which suppressed concerns whenever a fallthrough caused
 * Path B to execute on a repurposing-channel candidate. The unified judge
 * removes both asymmetries: every candidate gets the same shape of state
 * written (mechanismEvidence, counterEvidenceAddressed) so downstream
 * concerns can run universally.
 *
 * On LLM failure: if TxGNN context is available, fall back to TxGNN's
 * templated score+rationale (preserves the old Path A behavior as a
 * degraded mode). Otherwise return null and let synthesize-match surface
 * the missing-mechanism signal.
 *
 * Spec: docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md
 * → mechanism-plausibility.
 */

import type {
  KGPath,
  RepurposingCandidate,
} from "@clinical-trial-matching/shared";

import { llm } from "../../../llm.js";
import {
  MechanismPlausibilityJudgmentSchema,
  mechanismScorePrompt,
} from "../../../prompts/mechanism-plausibility.js";
import { pathBetween, resolveDrugByName } from "../../../tools/kg.js";
import { resolveSnomedCondition } from "../../../tools/snomed-mondo.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const MAX_KG_PATHS_PER_PROMPT = 6;
const PATHS_PER_PAIR = 3;

// Whitelist of PrimeKG relationship types that carry mechanism meaning for
// a drug → disease query. Deliberately excludes:
//   - `parent-child`     : disease/gene taxonomy (not mechanism)
//   - `contraindication` : negative signal — must not be framed as "mechanism evidence"
//   - `synergistic interaction` : drug-drug (irrelevant to single-drug mechanism)
const MECHANISM_REL_TYPES: readonly string[] = [
  "target",
  "enzyme",
  "transporter",
  "carrier",
  "ppi",
  "associated with",
  "indication",
  "off-label use",
];

const judgeScore = llm.withStructuredOutput(MechanismPlausibilityJudgmentSchema);

export async function mechanismPlausibility(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const repurposingContext = pickSource(
    state.candidate.repurposingDrugIds,
    state.repurposingCandidates,
  );

  // search-trials' construction guarantees that a repurposing-tagged
  // candidate has a matching RepurposingCandidate; if it doesn't, the
  // channel marker survived an upstream filter that dropped the supporting
  // record. Log loudly but don't refuse to score — the LLM can still judge
  // on KG paths + literature alone, and the prompt notes the missing TxGNN
  // context honestly.
  if (
    !repurposingContext &&
    state.candidate.discoveredVia.includes("repurposing")
  ) {
    console.error(
      `mechanism-plausibility: ${state.candidate.nctId} tagged repurposing but no matching RepurposingCandidate in state (drugIds=${JSON.stringify(state.candidate.repurposingDrugIds)}); judging without TxGNN context`,
    );
  }

  const kgPaths = await collectPaths(state);

  try {
    const judgment = await judgeScore.invoke(
      mechanismScorePrompt(
        state.patientProfile,
        state.candidate,
        state.mechanisms,
        kgPaths,
        state.literatureSupport,
        state.counterEvidence,
        repurposingContext ?? null,
      ),
    );
    return {
      mechanismScore: Math.max(0, Math.min(100, Math.round(judgment.score))),
      mechanismRationale: judgment.rationale,
      mechanismEvidence: judgment.evidence,
      counterEvidenceAddressed: judgment.counterEvidenceAddressed ?? null,
    };
  } catch (err) {
    // Dump the full error object so structured-output parse failures
    // surface their schema/HTTP cause; this is the main diagnostic for
    // recurring Haiku failures on this schema.
    console.warn(
      `mechanism-plausibility: LLM failed for ${state.candidate.nctId}: ${errorMessage(err)}`,
      err,
    );
    if (repurposingContext) {
      // Degraded mode: TxGNN's prior gives us a usable score and a
      // templated rationale. Better than null when we have it.
      return {
        mechanismScore: Math.round((repurposingContext.predIndication ?? 0) * 100),
        mechanismRationale: templatedTxgnnRationale(repurposingContext),
        mechanismEvidence: [],
        counterEvidenceAddressed: null,
      };
    }
    return {
      mechanismScore: null,
      mechanismRationale: null,
      mechanismEvidence: [],
      counterEvidenceAddressed: null,
    };
  }
}

// ---------- Helpers ----------

function pickSource(
  drugIds: readonly string[],
  candidates: RepurposingCandidate[],
): RepurposingCandidate | undefined {
  const matching = candidates.filter((rc) => drugIds.includes(rc.drug.id));
  if (matching.length === 0) return undefined;
  return matching.reduce((best, c) =>
    (c.predIndication ?? 0) > (best.predIndication ?? 0) ? c : best,
  );
}

// LLM-failure fallback rationale. Mirrors the shape the old Path A
// produced so downstream UI doesn't see a structural change when the
// judge is unavailable. The "(LLM judge unavailable...)" suffix makes
// the degraded mode visible to anyone reading the match.
function templatedTxgnnRationale(source: RepurposingCandidate): string {
  const score = (source.predIndication ?? 0).toFixed(2);
  const indications = source.originalIndications.join(", ") || "(unknown)";
  const pathSummary =
    source.supportingPaths.length > 0
      ? `via ${formatPathSummary(source.supportingPaths[0]!)}`
      : "no TxGNN explanation path available";
  return `TxGNN predicted ${source.drug.name} for ${indications} (indication ${score}); ${pathSummary} (LLM judge unavailable; fell back to TxGNN score).`;
}

// Pick the intermediate node names from a KG path, skipping the drug
// (first) and disease (last) so the output reads like "EGFR / ERBB
// signaling pathway".
function formatPathSummary(path: KGPath): string {
  if (path.nodes.length <= 2) return "direct association";
  return path.nodes
    .slice(1, -1)
    .map((n) => n.name)
    .join(" / ");
}

async function collectPaths(state: TrialEvalStateType): Promise<KGPath[]> {
  const drugIds: string[] = [];
  for (const name of state.candidate.interventions) {
    try {
      const node = await resolveDrugByName(name);
      if (node) drugIds.push(node.id);
    } catch (err) {
      console.warn(`mechanism-plausibility: resolveDrugByName(${name}) failed: ${errorMessage(err)}`);
    }
  }

  const diseaseIds: string[] = [];
  for (const m of state.mechanisms) {
    const resolved = resolveSnomedCondition(m.conditionId);
    if (resolved) diseaseIds.push(resolved.primekgNodeId);
  }

  if (drugIds.length === 0 || diseaseIds.length === 0) return [];

  const pairs: Array<Promise<KGPath[]>> = [];
  for (const drugId of drugIds) {
    for (const diseaseId of diseaseIds) {
      pairs.push(safePathBetween(drugId, diseaseId));
    }
  }

  const settled = await Promise.all(pairs);
  return roundRobinCap(settled, MAX_KG_PATHS_PER_PROMPT);
}

async function safePathBetween(drugId: string, diseaseId: string): Promise<KGPath[]> {
  try {
    return await pathBetween(drugId, diseaseId, MECHANISM_REL_TYPES, 3, PATHS_PER_PAIR);
  } catch (err) {
    console.warn(`mechanism-plausibility: pathBetween(${drugId}, ${diseaseId}) failed: ${errorMessage(err)}`);
    return [];
  }
}

// Take up to `cap` paths total, drawing in round-robin from each pair's
// returned set. Ensures every (intervention, condition) pair contributes
// at least one path before any pair contributes a second.
function roundRobinCap(pairs: KGPath[][], cap: number): KGPath[] {
  const out: KGPath[] = [];
  let idx = 0;
  while (out.length < cap) {
    let advanced = false;
    for (const pair of pairs) {
      if (idx < pair.length) {
        out.push(pair[idx]!);
        if (out.length >= cap) return out;
        advanced = true;
      }
    }
    if (!advanced) break;
    idx++;
  }
  return out;
}
