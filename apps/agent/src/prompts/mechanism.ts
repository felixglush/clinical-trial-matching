import type { PatientProfile, Mechanism } from "@clinical-trial-matching/shared";

export function mechanismPrompt(
  _profile: PatientProfile,
  _kgFindings: Mechanism[],
): string {
  // TODO: prompt that summarizes KG findings into clinically meaningful mechanisms
  return "";
}
