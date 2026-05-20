import type { TrialEvalStateType } from "../state.js";

export async function synthesizeMatch(
  _state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: combine eligibility + mechanism + literature into a TrialMatch with score.
  return { match: null };
}
