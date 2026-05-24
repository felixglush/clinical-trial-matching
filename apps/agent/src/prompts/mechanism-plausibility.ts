/**
 * # prompts/mechanism-plausibility
 *
 * Unified mechanism-plausibility prompt: the LLM judges biological
 * plausibility using up to three signal sources, with provenance made
 * explicit so the judge can weight them appropriately:
 *
 *   - KG paths from `kg.pathBetween` (strategy-side: structural evidence
 *     of how the intervention connects to the patient's mechanism).
 *   - Tiered PubMed literature (supporting + counter-evidence).
 *   - TxGNN repurposing prediction (when the trial was surfaced through
 *     the repurposing channel): predicted indication/contraindication
 *     scores plus the explanation path TxGNN used.
 *
 * Single-channel candidates get a subset of the above. The prompt always
 * states the discovery channel(s) so the LLM knows which signals are
 * present and why.
 */

import { z } from "zod";

import type {
  Citation,
  KGPath,
  Mechanism,
  PatientProfile,
  RepurposingCandidate,
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

// Unified mechanism judge: integrates KG paths, literature, and (when the
// candidate came from the repurposing channel) the TxGNN prediction. The
// LLM is told which channel(s) surfaced this trial so it can weigh each
// signal with provenance in mind.
export function mechanismScorePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  kgPaths: KGPath[],
  supporting: Citation[],
  counter: Citation[],
  repurposingContext: RepurposingCandidate | null,
): string {
  const grouped = groupByTier(supporting);
  const literatureBlock = [
    `${tierLabel(1)}:`,
    formatTier(grouped[1]),
    "",
    `${tierLabel(2)}:`,
    formatTier(grouped[2]),
    "",
    `${tierLabel(3)}:`,
    formatTier(grouped[3]),
  ].join("\n");

  const counterBlock =
    counter.length > 0
      ? counter.map((c) => formatCitation(c)).join("\n\n")
      : "  No counter-evidence retrieved.";

  return [
    "You are scoring the biological plausibility of a clinical trial's",
    "intervention(s) targeting this patient's disease mechanisms. Multiple",
    "evidence sources are provided below; each is labelled with its",
    "provenance so you can weight it appropriately. Integrate all signals",
    "into a single 0-100 score.",
    "",
    patientLine(profile),
    "",
    trialBlock(candidate),
    "",
    discoveryChannelBlock(candidate, repurposingContext),
    "",
    "Patient mechanisms (gene targets + pathways from PrimeKG):",
    mechanisms.map(formatMechanism).join("\n\n") || "  (none)",
    "",
    kgPaths.length > 0
      ? "Sample KG paths between trial intervention(s) and patient condition(s) (source: PrimeKG, ≤3 hops, mechanism-relevant edges only):"
      : "No KG path found within 3 hops between any (intervention, condition) pair.",
    kgPaths.length > 0 ? kgPaths.map(formatPath).join("\n\n") : "",
    "",
    "Supporting literature from PubMed (grouped by evidence tier):",
    "  Tier-1: randomized controlled trials, meta-analyses, systematic reviews.",
    "  Tier-2: other clinical studies and reviews (default bucket).",
    "  Tier-3: case reports, editorials, comments, letters, news, personal narratives.",
    literatureBlock,
    "",
    "Counter-evidence from PubMed (papers describing failure / futility / toxicity / withdrawal):",
    counterBlock,
    "",
    "How to weight signals:",
    "  - Tier-1 literature outweighs Tier-2; Tier-2 outweighs Tier-3.",
    "  - KG paths are structural priors, not outcome data. KG-only support",
    "    without literature: cap at ~55.",
    "  - TxGNN prediction (when present) is a learned drug-repurposing prior",
    "    over a curated knowledge graph. Treat a high TxGNN score as",
    "    suggestive, not confirmatory: it raises the floor (a strong TxGNN",
    "    prediction with no literature still warrants ~50-65), but cannot",
    "    overrule explicit counter-evidence in the literature.",
    "  - When TxGNN prediction and literature/KG agree, the score should be",
    "    higher than either signal alone would justify. When they disagree,",
    "    favor the literature and explain the disagreement in the rationale.",
    "  - Strong counter-evidence significantly reduces the score regardless",
    "    of other signals.",
    "",
    "Return:",
    "  - score: integer 0-100.",
    "  - rationale: 2-3 sentences integrating the signals above into a",
    "    biological argument. If a TxGNN prediction was provided, state",
    "    explicitly whether the literature/KG support, contradict, or are",
    "    silent on it.",
    "  - evidence: 2-4 entries drawn from the literature blocks. Each must:",
    "      - pmid: a PMID actually present above (do NOT invent)",
    "      - quote: short verbatim excerpt from that paper's abstract (≤200 chars)",
    "      - supports: 'yes' / 'weak' / 'no'",
    "    Include at least one counter-evidence quote (supports: 'no') if any",
    "    counter-evidence is present.",
    "  - counterEvidenceAddressed: if counter-evidence is present, one sentence",
    "    on whether/how it changes the score. Omit if no counter-evidence.",
  ].join("\n");
}

function discoveryChannelBlock(
  candidate: TrialCandidate,
  repurposing: RepurposingCandidate | null,
): string {
  const channels = candidate.discoveredVia.join(" + ");
  const lines = [`Discovery channel(s): ${channels}`];
  if (repurposing) {
    const indication = (repurposing.predIndication ?? 0).toFixed(2);
    const contra = (repurposing.predContraindication ?? 0).toFixed(2);
    const original = repurposing.originalIndications.join(", ") || "(unknown)";
    lines.push(
      `  TxGNN repurposing prediction (source: TxGNN drug-disease model over PrimeKG):`,
      `    drug: ${repurposing.drug.name} (${repurposing.drug.id})`,
      `    originally indicated for: ${original}`,
      `    predIndication: ${indication}   (higher = TxGNN predicts this drug treats the patient's disease)`,
      `    predContraindication: ${contra}   (higher = TxGNN predicts this drug is contraindicated; treat as a negative signal)`,
    );
    if (repurposing.supportingPaths.length > 0) {
      lines.push(
        `    TxGNN explanation path: ${formatPathSummary(repurposing.supportingPaths[0]!)}`,
      );
    } else {
      lines.push(`    TxGNN explanation path: (none available)`);
    }
  } else if (candidate.discoveredVia.includes("repurposing")) {
    // Channel claims repurposing but no matching RepurposingCandidate was
    // passed in. Tell the LLM honestly — don't fabricate TxGNN context.
    lines.push(
      `  (Trial tagged as discovered via repurposing, but no matching TxGNN prediction record was available — judge on KG paths + literature alone.)`,
    );
  } else {
    lines.push(
      `  (Strategy channel: trial found by mechanism keyword search; no TxGNN repurposing prediction is associated with this trial.)`,
    );
  }
  return lines.join("\n");
}

// Render an explanation path as "Drug → INTERMEDIATE → Disease" using the
// node names. Used for the TxGNN provenance block; deliberately simpler
// than `formatPath` (which renders edge relations) because the TxGNN
// supportingPath is already a curated explanation, not raw KG output.
function formatPathSummary(path: KGPath): string {
  if (path.nodes.length === 0) return "(empty)";
  return path.nodes.map((n) => n.name).join(" → ");
}

function groupByTier(cits: Citation[]): Record<EvidenceTier, Citation[]> {
  const out: Record<EvidenceTier, Citation[]> = { 1: [], 2: [], 3: [] };
  for (const c of cits) {
    out[tierForCitation(c)].push(c);
  }
  return out;
}

function formatTier(cits: Citation[]): string {
  if (cits.length === 0) return "  (none)";
  return cits.map((c) => formatCitation(c)).join("\n\n");
}

function formatCitation(c: Citation): string {
  return [
    `  [${c.pmid}] ${c.title}`,
    `  Pubtype: ${c.pubtype.join(", ") || "(none)"}`,
    `  Abstract excerpt: ${c.abstractExcerpt ?? "(unavailable)"}`,
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
