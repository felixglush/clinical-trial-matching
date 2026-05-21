import { z } from "zod";
import type { PatientProfile } from "@clinical-trial-matching/shared";

import type { CandidateMechanism } from "../tools/kg.js";

// Cap how many gene / pathway names we feed the LLM per condition. The full
// lists still live on the candidate mechanism — this only trims the prompt.
const GENES_PER_PROMPT = 8;
const PATHWAYS_PER_PROMPT = 8;
const MAX_PICKS = 5;

// Structured output schema for the LLM. The LLM returns an ordered list of
// conditionIds it considers most clinically relevant, each with a
// one-sentence rationale.
//
// We do not use `.max(MAX_PICKS)` here because it would emit `maxItems` into
// the JSON Schema; some OpenRouter providers (notably Amazon Bedrock for
// Anthropic models) reject that property and return a 400. The prompt asks
// the model for "up to 5" and the node slices to MAX_PICKS after parsing.
export const MechanismPicksSchema = z.object({
  picks: z.array(
    z.object({
      conditionId: z.string(),
      rationale: z.string(),
    }),
  ),
});
export type MechanismPicks = z.infer<typeof MechanismPicksSchema>;
export const MECHANISM_PICKS_CAP = MAX_PICKS;

export function mechanismPrompt(
  profile: PatientProfile,
  candidates: CandidateMechanism[],
): string {
  const patientLine = patientSummary(profile);
  const activeConditions = profile.conditions
    .filter(isActiveCondition)
    .map((c) => `  - ${c.display} (SNOMED ${c.code})`)
    .join("\n");
  const candidateBlocks = candidates.map(formatCandidate).join("\n\n");
  const idList = candidates.map((c) => c.conditionId).join(", ");

  return [
    "You are selecting which disease mechanisms are most clinically relevant",
    "for matching this patient to oncology and drug-repurposing trials.",
    "",
    "Patient:",
    `  ${patientLine}`,
    "",
    "Active conditions on the patient profile:",
    activeConditions || "  (none)",
    "",
    "Candidate mechanisms (one per resolved condition; gene targets and",
    "pathways come from PrimeKG):",
    "",
    candidateBlocks,
    "",
    "Return up to 5 picks, ordered by clinical priority. Prefer mechanisms",
    "tied to oncology or repurposing-relevant pathways over mechanisms",
    "dominated by background comorbidities (e.g., mild hypertension) when",
    "a primary driver is present.",
    "",
    "Each pick must:",
    `  - use a conditionId from this set: ${idList}`,
    "  - use each conditionId at most once (one mechanism summary per",
    "    condition; do not repeat the same conditionId across picks)",
    "  - include a single-sentence rationale that references the patient's",
    "    profile (age, primary diagnosis, comorbidities) and the specific",
    "    pathway or gene driving the choice.",
  ].join("\n");
}

function patientSummary(profile: PatientProfile): string {
  const parts = [
    `${profile.displayName} (id=${profile.id})`,
    `${profile.ageYears}yo`,
    profile.sex,
  ];
  if (profile.deceased) parts.push("deceased");
  return parts.join(", ");
}

function isActiveCondition(c: PatientProfile["conditions"][number]): boolean {
  // Mirrors the filter applied in the identify-relevant-mechanisms node so
  // the prompt and the candidate set stay in sync.
  if (!c.clinicalStatus) return true;
  return (
    c.clinicalStatus === "active" ||
    c.clinicalStatus === "recurrence" ||
    c.clinicalStatus === "relapse"
  );
}

function formatCandidate(m: CandidateMechanism): string {
  const genes = m.geneTargets
    .slice(0, GENES_PER_PROMPT)
    .map((g) => g.name)
    .join(", ");
  const pathways = m.pathways
    .slice(0, PATHWAYS_PER_PROMPT)
    .map((p) => p.name)
    .join(", ");
  return [
    `[${m.conditionId}] ${m.conditionName}`,
    `  Genes (top ${GENES_PER_PROMPT}): ${genes || "(none found)"}`,
    `  Pathways (top ${PATHWAYS_PER_PROMPT}): ${pathways || "(none found)"}`,
  ].join("\n");
}
