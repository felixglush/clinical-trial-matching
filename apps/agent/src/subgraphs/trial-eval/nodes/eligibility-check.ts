import type { TrialEvalStateType } from "../state.js";

export async function eligibilityCheck(
  _state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: per-criterion analysis with eligibilityPrompt
  return { eligibility: null };
}
