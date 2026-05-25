/**
 * # eligibility-check (trial-eval subgraph)
 *
 * Two steps:
 *
 *   1. Deterministic safety check: resolve each trial intervention to a
 *      PrimeKG drug node via `kg.resolveDrugByName`; resolve each active
 *      patient condition via the existing SNOMED→MONDO crosswalk; query
 *      Cypher for `(drug)-[:contraindication]-(disease)` edges between
 *      the resolved sets. Produces `SafetyConcern[]`.
 *   2. LLM per-criterion analysis: prompt receives the patient profile,
 *      full eligibility text (truncated to ELIGIBILITY_FULL_CHARS), and
 *      the structured `SafetyConcern[]` so it can downgrade `overall`
 *      when a concern is clinically relevant. Returns
 *      `{ inclusion[], exclusion[], overall }`; the node merges in the
 *      deterministic `safetyConcerns`.
 *
 * Never returns `{error}` — the subgraph contract is to always produce a
 * TrialMatch downstream. LLM failure falls back to `overall: "unclear"`.
 */

import type {
  EligibilityAssessment,
  SafetyConcern,
} from "@clinical-trial-matching/shared";

import { llm } from "../../../llm.js";
import {
  EligibilityJudgmentSchema,
  eligibilityPrompt,
} from "../../../prompts/eligibility.js";
import {
  findContraindicationsForDrugs,
  resolveDrugByName,
} from "../../../tools/kg.js";
import { resolveSnomedCondition } from "../../../tools/snomed-mondo.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const judgeEligibility = llm.withStructuredOutput(EligibilityJudgmentSchema);

export async function eligibilityCheck(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const { patientProfile, candidate } = state;
  const safetyConcerns = await runSafetyStep(
    candidate.interventions,
    patientProfile.conditions
      .filter((c) => !c.clinicalStatus || c.clinicalStatus === "active" ||
        c.clinicalStatus === "recurrence" || c.clinicalStatus === "relapse")
      .map((c) => c.code),
  );

  const judgment = await runLLMStep(state, safetyConcerns);

  const eligibility: EligibilityAssessment = {
    ...judgment,
    safetyConcerns,
  };
  return { eligibility };
}

async function runSafetyStep(
  interventions: string[],
  snomedCodes: string[],
): Promise<SafetyConcern[]> {
  try {
    const drugIds: string[] = [];
    for (const name of interventions) {
      const node = await resolveDrugByName(name);
      if (node) drugIds.push(node.id);
    }
    const diseaseIds: string[] = [];
    for (const code of snomedCodes) {
      const resolved = resolveSnomedCondition(code);
      if (resolved) diseaseIds.push(resolved.primekgNodeId);
    }
    return await findContraindicationsForDrugs(drugIds, diseaseIds);
  } catch (err) {
    console.warn(
      `eligibility-check: safety step failed: ${errorMessage(err)} (continuing with empty concerns)`,
    );
    return [];
  }
}

async function runLLMStep(
  state: TrialEvalStateType,
  safetyConcerns: SafetyConcern[],
): Promise<Omit<EligibilityAssessment, "safetyConcerns">> {
  try {
    const prompt = eligibilityPrompt(state.patientProfile, state.candidate, safetyConcerns);
    return await judgeEligibility.invoke(prompt);
  } catch (err) {
    console.warn(
      `eligibility-check: LLM failed (${state.candidate.nctId}): ${errorMessage(err)} (falling back to unclear)`,
    );
    return { inclusion: [], exclusion: [], overall: "unclear" };
  }
}
