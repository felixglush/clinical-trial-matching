/**
 * # prompts/mechanism-plausibility
 *
 * Strategy-channel (Path B) prompt for `mechanism-plausibility`:
 * LLM gets KG paths from `kg.pathBetween` and produces a 0-100 score
 * with rationale.
 *
 * Path A (repurposing channel) does NOT use an LLM — it's templated
 * directly in the node (`subgraphs/trial-eval/nodes/mechanism-plausibility.ts`)
 * because `find-repurposing-candidates` and the TxGNN explanation data
 * already carry the rationale content; calling an LLM here would
 * duplicate work the synthesize-match narrate LLM also does.
 */

import { z } from "zod";

import type {
  KGPath,
  Mechanism,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

const GENES_PER_PROMPT = 6;
const PATHWAYS_PER_PROMPT = 6;

export const MechanismPlausibilityJudgmentSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string(),
});
export type MechanismPlausibilityJudgment = z.infer<typeof MechanismPlausibilityJudgmentSchema>;

// Path B — strategy channel: score + narrate.
export function mechanismScorePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  kgPaths: KGPath[],
): string {
  return [
    "You are scoring the biological plausibility of a clinical trial's",
    "intervention(s) targeting this patient's disease mechanisms.",
    "",
    patientLine(profile),
    "",
    trialBlock(candidate),
    "",
    "Patient mechanisms (gene targets + pathways from PrimeKG):",
    mechanisms.map(formatMechanism).join("\n\n") || "  (none)",
    "",
    kgPaths.length > 0
      ? "Sample KG paths between trial intervention(s) and patient condition(s):"
      : "No KG path found within 3 hops between any (intervention, condition) pair.",
    kgPaths.length > 0 ? kgPaths.map(formatPath).join("\n\n") : "",
    "",
    "Return:",
    "  - score: 0-100 (0 = no plausible mechanism / unrelated; 50 = indirect",
    "    support / weak path; 100 = direct, well-supported by KG path)",
    "  - rationale: 2-3 sentences referencing the specific path or, if no",
    "    path was found, why the score is low.",
  ].join("\n");
}

function patientLine(p: PatientProfile): string {
  return `Patient: ${p.ageYears}yo ${p.sex}`;
}

function trialBlock(c: TrialCandidate): string {
  return [
    "Trial:",
    `  title: ${c.title}`,
    `  conditions: ${c.conditions.join(", ") || "(none)"}`,
    `  interventions: ${c.interventions.join(", ") || "(none)"}`,
  ].join("\n");
}

function formatMechanism(m: Mechanism): string {
  const genes = m.geneTargets
    .slice(0, GENES_PER_PROMPT)
    .map((g) => g.name)
    .join(", ") || "(none)";
  const pathways = m.pathways
    .slice(0, PATHWAYS_PER_PROMPT)
    .map((p) => p.name)
    .join(", ") || "(none)";
  return [
    `[${m.conditionId}] ${m.conditionName}`,
    `  genes: ${genes}`,
    `  pathways: ${pathways}`,
  ].join("\n");
}

function formatPath(p: KGPath): string {
  // "Osimertinib (DB09330) -[target]- EGFR -[associated with]- non-small cell lung carcinoma (MONDO:0005233)"
  const segments: string[] = [];
  for (let i = 0; i < p.nodes.length; i++) {
    const n = p.nodes[i]!;
    segments.push(`${n.name} (${n.id})`);
    const edge = p.edges[i];
    if (edge) segments.push(`-[${edge.relation}]-`);
  }
  return "  " + segments.join(" ");
}
