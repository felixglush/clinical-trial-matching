import type { AgentStateType } from "../state.js";

export async function findRepurposingCandidates(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: pathwayIds = mechanisms.flatMap(m => m.pathways.map(p => p.id));
  // kg.findDrugsTargetingPathways(pathwayIds); LLM-narrate rationale for each.
  return { repurposingCandidates: [] };
}
