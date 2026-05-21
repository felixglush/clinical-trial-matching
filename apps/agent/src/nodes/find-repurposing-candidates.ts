/**
 * # find-repurposing-candidates
 *
 * For each kept patient mechanism (disease + MONDO id), look up the top-N
 * TxGNN-predicted drugs and emit them as `RepurposingCandidate[]` for
 * downstream consumption. The list is deduped across mechanisms by drug
 * id: when the same drug surfaces for multiple patient diseases, we keep
 * the highest-scoring prediction as the canonical row and union the source
 * disease names into `originalIndications`.
 *
 * ## Pipeline
 *
 * ```text
 *   state.mechanisms : Mechanism[]   (≤5 from identify-relevant-mechanisms)
 *       │
 *       │  ensureTxgnnLoaded()   — lazy data-file load; throws on missing
 *       ▼
 *   for each mechanism:
 *     ├─ isCovered(mondoId)?               — skip + warn if uncovered
 *     ├─ lookupPredictions(mondoId, 10)    — top-10 TxGNN predictions
 *     └─ lookupExplanation(mondoId, drugId) per pred  — KGPath or null
 *       │
 *       │  aggregate by drug.id:
 *       │     - keep highest-predIndication row as canonical
 *       │     - union source-disease names into originalIndications
 *       ▼
 *   state.repurposingCandidates : RepurposingCandidate[]   (≤50 after dedup)
 * ```
 *
 * ## Downstream consumers
 *
 *   1. `search-trials` issues one CT.gov query per candidate using
 *      `drug.name` as the intervention term. Trials surfaced this way
 *      converge with the search-strategy channel via nctId dedup.
 *   2. `trial-eval`'s `mechanism-plausibility` (future plan) consumes
 *      `supportingPaths` (the TxGNN explainer path) when a matched trial
 *      came from this channel.
 *   3. `rank-and-synthesize` (future plan) surfaces candidates whose drug
 *      doesn't appear in any matched trial as a "no-trial leads" appendix.
 *
 * ## Coverage and error model
 *
 *   - 0 mechanisms              → return {repurposingCandidates: []}; not an
 *                                 error (no work to do).
 *   - Some MONDOs uncovered     → process the covered ones; warn-log the
 *                                 misses, mirroring identify-relevant-
 *                                 mechanisms's unresolved-SNOMED behavior.
 *   - All MONDOs uncovered      → return {repurposingCandidates: []}; not
 *                                 an error (warn already emitted).
 *   - TxGNN data unloadable     → return {error: ...}; per spec, missing
 *                                 data is a build-time bug and must surface
 *                                 loudly. The search-strategy channel still
 *                                 runs independently.
 *
 * ## Why dedup by drug.id (not by drug+disease pair)
 *
 * A drug predicted for multiple patient diseases is one *candidate* with
 * multiple source contexts, not multiple candidates. Surfacing it twice
 * would inflate the brief and confuse downstream NCT-dedup logic in
 * `rank-and-synthesize`. We keep the highest-scoring row to anchor the
 * prediction; `originalIndications` carries the full list of diseases
 * that surfaced it.
 */

import type {
  KGPath,
  Mechanism,
  RepurposingCandidate,
} from "@clinical-trial-matching/shared";

import {
  ensureTxgnnLoaded,
  isCovered,
  lookupExplanation,
  lookupPredictions,
  type TxGNNPrediction,
} from "../tools/txgnn.js";
import type { AgentStateType } from "../state.js";
import { errorMessage } from "../util/error.js";

const TOP_N_PER_MECHANISM = 10;

export async function findRepurposingCandidates(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const mechanisms = state.mechanisms;
  if (mechanisms.length === 0) {
    return { repurposingCandidates: [] };
  }

  try {
    await ensureTxgnnLoaded();
  } catch (err) {
    return { error: `Failed to load TxGNN data: ${errorMessage(err)}` };
  }

  const byDrug = new Map<string, DrugAccumulator>();
  const uncovered: string[] = [];

  for (const mech of mechanisms) {
    if (!isCovered(mech.mondoId)) {
      uncovered.push(mech.mondoId);
      continue;
    }
    const preds = lookupPredictions(mech.mondoId, TOP_N_PER_MECHANISM);
    for (const pred of preds) {
      const path = lookupExplanation(mech.mondoId, pred.drugId);
      accumulateByDrug(byDrug, pred, mech, path);
    }
  }

  if (uncovered.length > 0) {
    console.warn(
      `find-repurposing-candidates: ${uncovered.length} MONDO id(s) uncovered by TxGNN: ${uncovered.join(", ")}`,
    );
  }

  const out: RepurposingCandidate[] = [...byDrug.values()].map(
    ({ candidate, sourceDiseases }) => ({
      ...candidate,
      originalIndications: [...sourceDiseases].sort(),
    }),
  );

  return { repurposingCandidates: out };
}

// Per-drug aggregation across mechanisms. A drug appearing for multiple
// patient diseases keeps the highest-scoring row as the canonical
// candidate; all source diseases are unioned into the eventual
// `originalIndications`.
type DrugAccumulator = {
  candidate: RepurposingCandidate;
  sourceDiseases: Set<string>;
};

function accumulateByDrug(
  byDrug: Map<string, DrugAccumulator>,
  pred: TxGNNPrediction,
  mech: Mechanism,
  path: KGPath | null,
): void {
  const existing = byDrug.get(pred.drugId);
  if (existing) {
    existing.sourceDiseases.add(mech.conditionName);
    if (pred.predIndication > (existing.candidate.predIndication ?? 0)) {
      existing.candidate = buildCandidate(pred, mech, path);
    }
    return;
  }
  byDrug.set(pred.drugId, {
    candidate: buildCandidate(pred, mech, path),
    sourceDiseases: new Set([mech.conditionName]),
  });
}

function buildCandidate(
  pred: TxGNNPrediction,
  mech: Mechanism,
  path: KGPath | null,
): RepurposingCandidate {
  return {
    drug: { id: pred.drugId, name: pred.drugName, type: "drug" },
    originalIndications: [mech.conditionName],
    rationale: `TxGNN predicted for ${mech.conditionName} (indication ${pred.predIndication.toFixed(2)}).`,
    supportingPaths: path ? [path] : [],
    predIndication: pred.predIndication,
    predContraindication: pred.predContraindication,
  };
}
