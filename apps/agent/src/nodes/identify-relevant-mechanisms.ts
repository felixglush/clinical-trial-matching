import type { AgentStateType } from "../state.js";

export async function identifyRelevantMechanisms(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: for each condition in state.patientProfile.conditions, call
  // kg.buildMechanismsForConditions(); LLM-summarize the most clinically relevant ones.
  return { mechanisms: [] };
}
