import type {
  PatientProfile,
  Mechanism,
  TrialCandidate,
  KGPath,
} from "@clinical-trial-matching/shared";

export function mechanismPlausibilityPrompt(
  _profile: PatientProfile,
  _candidate: TrialCandidate,
  _mechanisms: Mechanism[],
  _kgPaths: KGPath[],
): string {
  // TODO: explains whether the trial's intervention plausibly addresses the patient's mechanism
  return "";
}
