/**
 * # identify-relevant-mechanisms
 *
 * For each active condition on `state.patientProfile`, resolves the SNOMED
 * code to a PrimeKG disease node (via the committed crosswalk), queries
 * Neo4j for that disease's gene targets and most-shared biological-process
 * pathways, then asks the LLM to rank-and-filter the candidates into the
 * top-K most clinically relevant mechanisms for trial matching.
 *
 * The result lands in `state.mechanisms`, ordered by clinical priority and
 * each carrying a one-sentence rationale from the LLM.
 */

import type {
  Condition,
  Mechanism,
  PatientProfile,
} from "@clinical-trial-matching/shared";

import {
  buildCandidateMechanisms,
  type CandidateMechanism,
  type ConditionInput,
} from "../tools/kg.js";
import {
  MECHANISM_PICKS_CAP,
  MechanismPicksSchema,
  mechanismPrompt,
} from "../prompts/mechanism.js";
import { llm } from "../llm.js";
import type { AgentStateType } from "../state.js";

const ACTIVE_STATUSES = new Set<Condition["clinicalStatus"]>([
  "active",
  "recurrence",
  "relapse",
]);

export async function identifyRelevantMechanisms(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const profile = state.patientProfile;
  if (!profile) {
    return { error: "No patient profile available" };
  }

  const conditions = activeConditionsAsInputs(profile);
  if (conditions.length === 0) {
    return { mechanisms: [] };
  }

  let candidates: CandidateMechanism[];
  let unresolved: string[];
  try {
    ({ candidates, unresolved } = await buildCandidateMechanisms(conditions));
  } catch (err) {
    return { error: `Failed to query KG: ${errorMessage(err)}` };
  }

  if (unresolved.length > 0) {
    console.warn(
      `identify-relevant-mechanisms: ${unresolved.length} SNOMED code(s) unresolved against PrimeKG crosswalk: ${unresolved.join(", ")}`,
    );
  }

  if (candidates.length === 0) {
    return { mechanisms: [] };
  }

  let picks;
  try {
    const structured = llm.withStructuredOutput(MechanismPicksSchema);
    const prompt = mechanismPrompt(profile, candidates);
    picks = (await structured.invoke(prompt)).picks;
  } catch (err) {
    return { error: `Failed to rank mechanisms: ${errorMessage(err)}` };
  }

  const cappedPicks = picks.slice(0, MECHANISM_PICKS_CAP);
  const mechanisms = orderedMechanismsFromPicks(cappedPicks, candidates);
  return { mechanisms };
}

function activeConditionsAsInputs(profile: PatientProfile): ConditionInput[] {
  return profile.conditions
    .filter((c) => !c.clinicalStatus || ACTIVE_STATUSES.has(c.clinicalStatus))
    .map((c) => ({ snomedCode: c.code, conditionDisplay: c.display }));
}

function orderedMechanismsFromPicks(
  picks: ReadonlyArray<{ conditionId: string; rationale: string }>,
  candidates: CandidateMechanism[],
): Mechanism[] {
  const byId = new Map(candidates.map((c) => [c.conditionId, c]));
  // Dedup defensively: the prompt says "each conditionId at most once" but if
  // the LLM ignores that we keep the first (most-relevant) pick per condition.
  const seen = new Set<string>();
  const out: Mechanism[] = [];
  for (const p of picks) {
    const cand = byId.get(p.conditionId);
    if (!cand) {
      console.warn(
        `identify-relevant-mechanisms: LLM picked unknown conditionId '${p.conditionId}', skipping`,
      );
      continue;
    }
    if (seen.has(p.conditionId)) continue;
    seen.add(p.conditionId);
    out.push({ ...cand, rationale: p.rationale });
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
