import type { AgentStateType } from "../state.js";

export async function generateSearchStrategy(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: call LLM with searchStrategyPrompt(state.patientProfile, state.searchStrategy);
  // increment attempts; if state.searchStrategy is non-null, broaden.
  return {
    searchStrategy: null,
    attempts: state.attempts + 1,
  };
}
