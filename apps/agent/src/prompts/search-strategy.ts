import type {
  PatientProfile,
  Mechanism,
  SearchStrategy,
} from "@clinical-trial-matching/shared";

export function searchStrategyPrompt(
  _profile: PatientProfile,
  _mechanisms: Mechanism[],
  _previousAttempt: SearchStrategy | null,
): string {
  // TODO: implement prompt that produces SearchStrategy using condition AND
  // mechanism terms; broadens if previousAttempt set. Repurposing candidate
  // drug names are queried separately in search-trials and unioned.
  return "";
}
