/**
 * # mechanism-plausibility (trial-eval subgraph)
 *
 * Channel-aware scoring of "does the trial's intervention plausibly
 * address the patient's mechanism?"
 *
 *   - Path A (candidate.discoveredVia includes "repurposing"):
 *     score = TxGNN predIndication × 100; rationale is templated from
 *     the source RepurposingCandidate (drug name, score, intermediate
 *     node names from `supportingPaths`). NO LLM CALL — TxGNN's score
 *     and the explanation path already carry the content; the
 *     synthesize-match narrate LLM handles user-facing prose.
 *
 *   - Path B (strategy-only):
 *     `kg.pathBetween` per (intervention, mechanism) pair; LLM scores
 *     and narrates. Null on LLM failure → synthesize-match maps to 50
 *     with a concern.
 *
 * Spec: docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md
 * → mechanism-plausibility (Path A / Path B).
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
  const { candidate, repurposingCandidates } = state;
  if (candidate.discoveredVia.includes("repurposing")) {
    const out = runPathA(state, repurposingCandidates);
    if (out) return out;
    // Path A's source wasn't in state — fall through to Path B.
    console.warn(
      `mechanism-plausibility: candidate ${candidate.nctId} claims repurposing channel but no matching RepurposingCandidate found; falling back to Path B`,
    );
  }
  return await runPathB(state);
}

// ---------- Path A — repurposing channel (LLM-free) ----------

// Returns null when no matching RepurposingCandidate exists; caller
// falls back to Path B. Otherwise returns the Partial state directly.
function runPathA(
  state: TrialEvalStateType,
  repurposingCandidates: RepurposingCandidate[],
): Partial<TrialEvalStateType> | null {
  const source = pickSource(state.candidate.repurposingDrugIds, repurposingCandidates);
  if (!source) return null;

  const mechanismScore = Math.round((source.predIndication ?? 0) * 100);
  return {
    mechanismScore,
    mechanismRationale: templatedRationale(source),
  };
}

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

// Build the Path A rationale string with optional intermediate-node
// context from the TxGNN explanation path. Example outputs:
//
//   "TxGNN predicted osimertinib for non-small cell lung carcinoma
//    (indication 0.92); via EGFR / ERBB signaling pathway."
//
//   "TxGNN predicted metformin for type 2 diabetes mellitus
//    (indication 0.88); no TxGNN explanation path available."
function templatedRationale(source: RepurposingCandidate): string {
  const score = (source.predIndication ?? 0).toFixed(2);
  const indications = source.originalIndications.join(", ") || "(unknown)";
  const pathSummary =
    source.supportingPaths.length > 0
      ? `via ${formatPathSummary(source.supportingPaths[0]!)}`
      : "no TxGNN explanation path available";
  return `TxGNN predicted ${source.drug.name} for ${indications} (indication ${score}); ${pathSummary}.`;
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

// ---------- Path B — strategy channel ----------

async function runPathB(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
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
      ),
    );
    return {
      mechanismScore: Math.max(0, Math.min(100, Math.round(judgment.score))),
      mechanismRationale: judgment.rationale,
      mechanismEvidence: judgment.evidence,
      counterEvidenceAddressed: judgment.counterEvidenceAddressed ?? null,
    };
  } catch (err) {
    // Dump the full error object (not just .message) so structured-output
    // parse failures surface their schema/HTTP cause for diagnosis. Pinning
    // down the root cause of repeated Haiku failures on this schema requires
    // err.cause, err.stack, and any langchain-attached llmOutput.
    console.warn(
      `mechanism-plausibility (Path B): LLM failed for ${state.candidate.nctId}: ${errorMessage(err)} (null score)`,
      err,
    );
    return {
      mechanismScore: null,
      mechanismRationale: null,
      mechanismEvidence: [],
      counterEvidenceAddressed: null,
    };
  }
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
