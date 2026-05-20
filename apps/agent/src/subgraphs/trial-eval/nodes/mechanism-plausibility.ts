import type { TrialEvalStateType } from "../state.js";

export async function mechanismPlausibility(
  _state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: kg.pathBetween(intervention, condition) for each pair; LLM scores plausibility.
  return { mechanismScore: null, mechanismRationale: null };
}
