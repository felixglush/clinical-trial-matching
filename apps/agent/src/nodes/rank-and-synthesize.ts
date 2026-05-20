import type { AgentStateType } from "../state.js";

export async function rankAndSynthesize(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: call LLM with rankPrompt(state.patientProfile, state.matches);
  // re-order matches; produce approvalRequest summary.
  return {
    matches: state.matches,
    approvalRequest: null,
  };
}
