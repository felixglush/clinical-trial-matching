/**
 * # pre-filter
 *
 * Two-stage filter that cuts the candidate list from ~50–200 down to
 * ~10–30 before the expensive `trial-eval` fan-out.
 *
 * ## Stage 1 — deterministic gates
 *
 * Pure functions on `TrialCandidate` + `PatientProfile`. Drops the
 * candidate if any rule fires; each drop is recorded in
 * `state.candidateDrops` with `stage: "stage1"` and a `detail` matching
 * the gate that fired (raw status, parsed age string, etc.).
 *
 *   - status not enrolling-ish    → drop "not-recruiting"
 *   - patient age < minimumAge    → drop "age-too-young"
 *   - patient age > maximumAge    → drop "age-too-old"
 *   - sex mismatch                → drop "sex-mismatch"
 *   - patient deceased            → drop "deceased" (catches everything)
 *
 * Missing / unparseable structured fields skip the gate (lenient).
 *
 * ## Stage 2 — LLM-as-judge
 *
 * One Haiku call per Stage-1 survivor (bounded concurrency 10),
 * `withStructuredOutput(PreFilterJudgmentSchema)`. The prompt instructs
 * the model to KEEP when in doubt — false-negatives are expensive,
 * false-positives are cheap (trial-eval catches them downstream).
 *
 * LLM failure on a candidate → keep it (lenient); do NOT record a drop.
 * The audit log is for "we dropped X because Y" and a transient error
 * isn't that.
 *
 * ## Output
 *
 *   { candidates: kept, candidateDrops: drops }
 *
 * Both fields use replace-on-write reducers — a broaden-loop re-run
 * overwrites both with the new pass's results.
 */

import type {
  CandidateDrop,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import { llm } from "../llm.js";
import {
  PreFilterJudgmentSchema,
  preFilterPrompt,
} from "../prompts/pre-filter.js";
import type { AgentStateType } from "../state.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { errorMessage } from "../util/error.js";
import { isEnrollingStatus, parseAgeYears } from "../util/ctgov.js";

const STAGE2_CONCURRENCY = 10;

// Hoisted once per module load — constructing a new chain per candidate
// inside the hot loop is redundant since the schema never changes.
const stage2Judge = llm.withStructuredOutput(PreFilterJudgmentSchema);

export async function preFilter(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const profile = state.patientProfile;
  if (!profile) {
    return { error: "No patient profile available" };
  }
  if (state.candidates.length === 0) {
    return { candidates: [], candidateDrops: [] };
  }

  const drops: CandidateDrop[] = [];
  const stage1Survivors: TrialCandidate[] = [];

  for (const c of state.candidates) {
    const drop = stage1Drop(c, profile);
    if (drop) drops.push(drop);
    else stage1Survivors.push(c);
  }

  console.info(
    `pre-filter stage 1: ${state.candidates.length} in, ${stage1Survivors.length} kept, ${drops.length} dropped`,
  );

  const stage2Results = await mapWithConcurrency(
    stage1Survivors,
    STAGE2_CONCURRENCY,
    (c) => judgeStage2(c, profile),
  );

  const kept: TrialCandidate[] = [];
  for (let i = 0; i < stage1Survivors.length; i++) {
    const c = stage1Survivors[i]!;
    const judgment = stage2Results[i];
    if (judgment && !judgment.keep) {
      drops.push({
        nctId: c.nctId,
        title: c.title,
        reason: "llm-ineligible",
        stage: "stage2",
        detail: judgment.reason,
      });
    } else {
      kept.push(c);
    }
  }

  return { candidates: kept, candidateDrops: drops };
}

function stage1Drop(
  c: TrialCandidate,
  profile: PatientProfile,
): CandidateDrop | null {
  if (profile.deceased) {
    return drop(c, "deceased", "stage1");
  }
  if (!isEnrollingStatus(c.status)) {
    return drop(c, "not-recruiting", "stage1", c.status);
  }
  const minAge = parseAgeYears(c.minimumAge);
  if (minAge !== undefined && profile.ageYears < minAge) {
    return drop(c, "age-too-young", "stage1", c.minimumAge);
  }
  const maxAge = parseAgeYears(c.maximumAge);
  if (maxAge !== undefined && profile.ageYears > maxAge) {
    return drop(c, "age-too-old", "stage1", c.maximumAge);
  }
  if (
    c.sexEligibility &&
    c.sexEligibility !== "ALL" &&
    (profile.sex === "male" || profile.sex === "female") &&
    c.sexEligibility !== profile.sex.toUpperCase()
  ) {
    return drop(c, "sex-mismatch", "stage1", c.sexEligibility);
  }
  return null;
}

function drop(
  c: TrialCandidate,
  reason: CandidateDrop["reason"],
  stage: CandidateDrop["stage"],
  detail?: string,
): CandidateDrop {
  return { nctId: c.nctId, title: c.title, reason, stage, detail };
}

// Returns the parsed judgment, or null on LLM error (lenient keep).
async function judgeStage2(
  c: TrialCandidate,
  profile: PatientProfile,
): Promise<{ keep: boolean; reason: string } | null> {
  try {
    return await stage2Judge.invoke(preFilterPrompt(profile, c));
  } catch (err) {
    console.warn(
      `pre-filter: stage 2 LLM failed for ${c.nctId}: ${errorMessage(err)} (keeping)`,
    );
    return null;
  }
}
