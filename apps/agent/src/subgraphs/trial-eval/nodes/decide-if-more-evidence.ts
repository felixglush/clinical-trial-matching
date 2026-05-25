import type { TrialEvalStateType } from "../state.js";

const MIN_CITATIONS = 3;
const MAX_EVIDENCE_ATTEMPTS = 2;

export function decideIfMoreEvidence(
  state: TrialEvalStateType,
): "literature-support" | "mechanism-plausibility" {
  const needMore =
    state.literatureSupport.length < MIN_CITATIONS &&
    state.evidenceAttempts < MAX_EVIDENCE_ATTEMPTS;
  return needMore ? "literature-support" : "mechanism-plausibility";
}
