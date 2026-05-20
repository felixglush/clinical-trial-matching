import type { PatientProfile, TrialCandidate } from "@clinical-trial-matching/shared";

export function eligibilityPrompt(_profile: PatientProfile, _candidate: TrialCandidate): string {
  // TODO: per-criterion inclusion/exclusion analysis
  return "";
}
