/**
 * # prompts/mechanism-plausibility
 *
 * Strategy-channel (Path B) prompt for `mechanism-plausibility`:
 * LLM gets KG paths from `kg.pathBetween` plus tiered PubMed literature
 * (supporting + counter-evidence) and produces a 0-100 score with a
 * literature-cited rationale (v1.5).
 *
 * Path A (repurposing channel) does NOT use an LLM — it's templated
 * directly in the node (`subgraphs/trial-eval/nodes/mechanism-plausibility.ts`)
 * because `find-repurposing-candidates` and the TxGNN explanation data
 * already carry the rationale content; calling an LLM here would
 * duplicate work the synthesize-match narrate LLM also does.
 */

import { z } from "zod";

import type {
  Citation,
  KGPath,
  Mechanism,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import { tierForCitation, tierLabel, type EvidenceTier } from "../util/pubmed-tiers.js";

const GENES_PER_PROMPT = 6;
const PATHWAYS_PER_PROMPT = 6;

// Bedrock's tool-schema validator (reachable via OpenRouter routing) rejects
// `minimum`/`maximum` on any numeric type, plus `maxItems` on arrays. Zod 4's
// `.int()` *implicitly* injects safe-integer min/max into the emitted JSON
// Schema, so we use plain `z.number()` and round + clamp in the node.
export const MechanismPlausibilityJudgmentSchema = z.object({
  score: z.number(),
  rationale: z.string(),
  evidence: z.array(
    z.object({
      pmid: z.string(),
      quote: z.string(),
      supports: z.enum(["yes", "weak", "no"]),
    }),
  ),
  counterEvidenceAddressed: z.string().optional(),
});
export type MechanismPlausibilityJudgment = z.infer<typeof MechanismPlausibilityJudgmentSchema>;

// Path B — strategy channel: score + narrate with literature grounding.
export function mechanismScorePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  kgPaths: KGPath[],
  supporting: Citation[],
  counter: Citation[],
): string {
  const grouped = groupByTier(supporting);
  const literatureBlock = [
    `${tierLabel(1)}:`,
    formatTier(grouped[1], { showAbstract: true }),
    "",
    `${tierLabel(2)}:`,
    formatTier(grouped[2], { showAbstract: true }),
    "",
    `${tierLabel(3)}:`,
    formatTier(grouped[3], { showAbstract: false }),
  ].join("\n");

  const counterBlock =
    counter.length > 0
      ? counter.map((c) => formatCitation(c, { showAbstract: true })).join("\n\n")
      : "  No counter-evidence retrieved.";

  return [
    "You are scoring the biological plausibility of a clinical trial's",
    "intervention(s) targeting this patient's disease mechanisms. Use both",
    "KG paths AND published literature as evidence. Higher-tier literature",
    "outweighs lower-tier (Tier-1 > Tier-2 > Tier-3).",
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
    "Supporting literature (grouped by evidence tier):",
    literatureBlock,
    "",
    "Counter-evidence (papers describing failure / futility / toxicity / withdrawal):",
    counterBlock,
    "",
    "Return:",
    "  - score: integer 0-100. Weight Tier-1 strongly; Tier-2 moderately; Tier-3 lightly.",
    "    KG-only support without literature: cap at ~55. Strong Tier-1 support:",
    "    can reach 100. Strong counter-evidence: significantly reduce score.",
    "  - rationale: 2-3 sentences combining KG path + literature into a",
    "    biological argument.",
    "  - evidence: 2-4 entries. Each must:",
    "      - pmid: a PMID actually present above (do NOT invent)",
    "      - quote: short verbatim excerpt from that paper's abstract (≤200 chars)",
    "      - supports: 'yes' / 'weak' / 'no'",
    "    Include at least one counter-evidence quote (supports: 'no') if any",
    "    counter-evidence is present.",
    "  - counterEvidenceAddressed: if counter-evidence is present, one sentence",
    "    on whether/how it changes the score. Omit if no counter-evidence.",
  ].join("\n");
}

function groupByTier(cits: Citation[]): Record<EvidenceTier, Citation[]> {
  const out: Record<EvidenceTier, Citation[]> = { 1: [], 2: [], 3: [] };
  for (const c of cits) {
    out[tierForCitation(c)].push(c);
  }
  return out;
}

function formatTier(cits: Citation[], opts: { showAbstract: boolean }): string {
  if (cits.length === 0) return "  (none)";
  return cits.map((c) => formatCitation(c, opts)).join("\n\n");
}

function formatCitation(c: Citation, opts: { showAbstract: boolean }): string {
  const lines = [
    `  [${c.pmid}] ${c.title}`,
    `  Pubtype: ${c.pubtype.join(", ") || "(none)"}`,
  ];
  if (opts.showAbstract) {
    lines.push(`  Abstract excerpt: ${c.abstractExcerpt ?? "(unavailable)"}`);
  }
  return lines.join("\n");
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
