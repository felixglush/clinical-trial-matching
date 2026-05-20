import type { TrialEvalStateType } from "../state.js";

export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: pubmed.searchPubMed(query derived from trial + mechanism);
  // broaden query on subsequent evidenceAttempts.
  return {
    literatureSupport: [],
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}
