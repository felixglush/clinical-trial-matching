import type { AgentStateType } from "../state.js";

export async function preFilter(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: cheap LLM-as-judge to drop obvious non-matches from candidates.
  return { candidates: [] };
}
