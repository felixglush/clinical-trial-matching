import type { SearchStrategy, TrialCandidate } from "@clinical-trial-matching/shared";

export async function searchClinicalTrials(
  _strategy: SearchStrategy,
): Promise<TrialCandidate[]> {
  throw new Error("searchClinicalTrials not implemented");
}
