import type { AgentStateType } from "../state.js";

export async function rankAndSynthesize(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: call LLM with rankPrompt(state.patientProfile, state.matches);
  // re-order matches; produce approvalRequest summary. The `matches`
  // reducer is `concat` (for fan-out accumulation), so returning a
  // reordered list as `{ matches: ... }` would double-write. When
  // implementing, either change the reducer to replace semantics or
  // perform reordering via a separate field (e.g. `rankedMatches`).
  return { approvalRequest: null };
}
