import type { AgentStateType } from "../state.js";

export async function searchTrials(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: two queries against clinicaltrials.searchClinicalTrials():
  //   (1) state.searchStrategy (condition + mechanism terms)
  //   (2) state.repurposingCandidates → query by intervention drug names
  // Union and dedupe by nctId; store in candidates.
  return { candidates: [] };
}
