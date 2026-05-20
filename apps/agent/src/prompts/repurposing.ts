import type { Mechanism, RepurposingCandidate } from "@clinical-trial-matching/shared";

export function repurposingPrompt(
  _mechanisms: Mechanism[],
  _candidates: RepurposingCandidate[],
): string {
  // TODO: prompt that articulates why each repurposing candidate is biologically plausible
  return "";
}
