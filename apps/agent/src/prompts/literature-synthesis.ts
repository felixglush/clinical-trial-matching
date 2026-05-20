import type { Citation, TrialCandidate } from "@clinical-trial-matching/shared";

export function literatureSynthesisPrompt(
  _candidate: TrialCandidate,
  _citations: Citation[],
): string {
  // TODO: synthesizes PubMed hits into a brief support/refute paragraph
  return "";
}
