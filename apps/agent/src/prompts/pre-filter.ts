import type { PatientProfile, TrialCandidate } from "@clinical-trial-matching/shared";

export function preFilterPrompt(_profile: PatientProfile, _candidate: TrialCandidate): string {
  // TODO: implement cheap pre-filter prompt — pass/fail with brief reason
  return "";
}
