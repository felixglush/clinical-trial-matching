import type { PatientProfile, TrialMatch } from "@clinical-trial-matching/shared";

export function rankPrompt(_profile: PatientProfile, _matches: TrialMatch[]): string {
  // TODO: implement final ranking + synthesis prompt combining eligibility, mechanism, evidence
  return "";
}
