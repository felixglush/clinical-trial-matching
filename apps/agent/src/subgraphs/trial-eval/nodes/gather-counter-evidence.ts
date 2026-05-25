/**
 * # gather-counter-evidence (trial-eval subgraph)
 *
 * Collects structured biomedical counter-evidence for a candidate trial:
 *
 *   - PrimeKG (:drug)-[:contraindication]-(:disease) edges between each
 *     resolved trial intervention and the patient's mechanism conditions.
 *   - TxGNN `predContraindication` from the matching RepurposingCandidate
 *     (when the trial came through the repurposing channel).
 *   - CT.gov terminated / withdrawn / suspended prior trials of the drug +
 *     condition, with raw `whyStopped` text passed through unfiltered.
 *
 * Runs in parallel with `literature-support`. Both fan in to
 * `mechanism-plausibility`. Each fetcher is wrapped in a soft-fail so an
 * outage in one source doesn't kill the candidate's evaluation — failed
 * sources resolve to empty arrays / null and the prompt notes their
 * absence.
 *
 * Populates `state.structuredCounterEvidence`. Replaces the PubMed
 * sentiment-keyword OR-query that previously populated `state.counterEvidence`. See
 * docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md.
 */

import type { PriorTerminatedTrial, SafetyConcern } from "@clinical-trial-matching/shared";

import { searchTerminatedPriorTrials } from "../../../tools/clinicaltrials.js";
import { findContraindicationsForDrugs, resolveDrugByName } from "../../../tools/kg.js";
import { resolveSnomedCondition } from "../../../tools/snomed-mondo.js";
import { errorMessage } from "../../../util/error.js";
import { pickSource } from "../util/repurposing.js";
import type { TrialEvalStateType } from "../state.js";

const MAX_INTERVENTIONS_IN_QUERY = 3;

export async function gatherCounterEvidence(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const repurposingContext = pickSource(
    state.candidate.repurposingDrugIds,
    state.repurposingCandidates,
  );

  const [primeKgContraindications, terminatedPriorTrials] = await Promise.all([
    safeFetchPrimeKgContraindications(state),
    safeFetchTerminatedPriorTrials(state),
  ]);

  return {
    structuredCounterEvidence: {
      primeKgContraindications,
      txGnnPredContraindication: repurposingContext?.predContraindication ?? null,
      terminatedPriorTrials,
    },
  };
}

async function safeFetchPrimeKgContraindications(
  state: TrialEvalStateType,
): Promise<SafetyConcern[]> {
  try {
    const drugIds: string[] = [];
    for (const name of state.candidate.interventions) {
      const node = await resolveDrugByName(name);
      if (node) drugIds.push(node.id);
    }
    const diseaseIds: string[] = [];
    for (const m of state.mechanisms) {
      const resolved = resolveSnomedCondition(m.conditionId);
      if (resolved) diseaseIds.push(resolved.primekgNodeId);
    }
    if (drugIds.length === 0 || diseaseIds.length === 0) return [];
    return await findContraindicationsForDrugs(drugIds, diseaseIds);
  } catch (err) {
    console.warn(
      `gather-counter-evidence: PrimeKG contraindication fetch failed for ${state.candidate.nctId}: ${errorMessage(err)}`,
    );
    return [];
  }
}

async function safeFetchTerminatedPriorTrials(
  state: TrialEvalStateType,
): Promise<PriorTerminatedTrial[]> {
  const interventions = state.candidate.interventions.slice(0, MAX_INTERVENTIONS_IN_QUERY);
  if (interventions.length === 0) return [];
  const condition =
    state.mechanisms[0]?.conditionName ??
    state.patientProfile.conditions[0]?.display ??
    "";
  if (!condition) return [];

  const queries = interventions.map((intervention) =>
    searchTerminatedPriorTrials({ intervention, condition }).catch((err) => {
      console.warn(
        `gather-counter-evidence: CT.gov terminated lookup failed for intervention=${intervention} (${state.candidate.nctId}): ${errorMessage(err)}`,
      );
      return [] as PriorTerminatedTrial[];
    }),
  );

  const results = await Promise.all(queries);
  // Dedupe by nctId across the per-intervention queries.
  const byNctId = new Map<string, PriorTerminatedTrial>();
  for (const list of results) {
    for (const t of list) if (!byNctId.has(t.nctId)) byNctId.set(t.nctId, t);
  }
  return [...byNctId.values()];
}
