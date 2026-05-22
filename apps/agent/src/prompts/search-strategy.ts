/**
 * # prompts/search-strategy
 *
 * Builds the prompt for `generate-search-strategy`. Produces 1–4 free-text
 * ClinicalTrials.gov queries that combine the patient's primary conditions
 * with mechanism-level terms (genes, pathways), plus optional filters and
 * a record of any broadening applied on retry.
 *
 * ## What the LLM sees
 *
 *   Demographics ─────────► informs filters (phase, country); never goes
 *                            into query text
 *   Active conditions ────► query terms; primary disease anchors each query
 *   Mechanisms ───────────► query terms (gene names, pathway names);
 *                            mechanism.rationale provides clinical context
 *   Active medications ──┐
 *   Prior treatments ────┴► line-of-therapy qualifiers ("second-line",
 *                            "refractory", "salvage") — drug NAMES never
 *                            enter queries (handled by repurposing channel)
 *   Previous attempt ─────► triggers BROADENING_INSTRUCTIONS on retry
 *
 * ## Output schema (SearchStrategyPickSchema)
 *
 * The LLM returns `{queries, filters, broadeningApplied}`. The node fills
 * in `attempt` (the LLM should not invent it). All fields validated by
 * Zod — broadening notes are strings the LLM picks freely, but the queries
 * array MUST be non-empty.
 *
 * ## Why no .max() on the queries array
 *
 * The Anthropic-on-Bedrock path used by OpenRouter rejects JSON Schema
 * `maxItems`. We instruct the model in prose to return 1–4 queries and
 * trust the structured output to stay reasonable; the cap is enforced as
 * a soft expectation, not a schema constraint. Same reason `mechanism.ts`
 * avoids `.max(MAX_PICKS)`.
 */

import { z } from "zod";

import {
  isActiveCondition,
  isActiveMedication,
  SearchFiltersSchema,
  type Mechanism,
  type PatientProfile,
  type SearchStrategy,
} from "@clinical-trial-matching/shared";

const GENES_PER_PROMPT = 6;
const PATHWAYS_PER_PROMPT = 6;

export const SearchStrategyPickSchema = z.object({
  queries: z.array(z.string()).min(1),
  filters: SearchFiltersSchema,
  broadeningApplied: z.array(z.string()),
});
export type SearchStrategyPick = z.infer<typeof SearchStrategyPickSchema>;

const FIRST_ATTEMPT_INSTRUCTIONS = `
You are generating a search strategy for ClinicalTrials.gov to find trials
that may help this patient. Produce 1-4 free-text search queries combining
the patient's primary conditions with mechanism-level terms (gene targets,
pathway names) when they sharpen the query. When the treatment history
warrants it (see "Use the patient's context" below), add treatment-context
qualifiers.

Each query should be a short string ClinicalTrials.gov's full-text search
will accept - e.g. "type 2 diabetes SGLT2", "EGFR mutant NSCLC second-line",
"refractory rheumatoid arthritis JAK".

Use the patient's context:
- Active medications and prior treatments together tell you the line of
  therapy. Treatment-naive -> prefer first-line, untreated, newly-diagnosed
  qualifiers (or no qualifier). Patient already on standard agents for the
  same condition -> consider second-line, treatment-resistant, refractory,
  or maintenance qualifiers. Recent prior treatment with the same drug
  class -> consider salvage / post-progression. Do NOT put drug names
  themselves in queries - drug-specific lookups happen in a separate
  channel.
- Use age and sex to inform FILTERS, not queries. CT.gov full-text won't
  match age strings well. Adult patients (>= 18) with limited options can
  warrant PHASE1 inclusion; pediatric patients (< 18) need pediatric trials
  and should be flagged in broadeningApplied as a constraint to honor.

Prefer fewer high-precision queries over many noisy ones.

Filters: prefer recruiting trials (status: RECRUITING and/or
NOT_YET_RECRUITING). Set phase only when clearly appropriate from the
profile (e.g. PHASE2/PHASE3 for routine adult care; broader for limited
options). Leave country unset unless explicit signal.

broadeningApplied should be an empty list on the first attempt.
`.trim();

const BROADENING_INSTRUCTIONS = `
A previous attempt yielded too few candidates. Broaden the strategy and
record exactly what you changed in broadeningApplied (e.g. ["dropped phase
filter", "generalized SGLT2 to SGLT inhibitor", "removed second-line
qualifier"]). Do not narrow.
`.trim();

export function searchStrategyPrompt(
  profile: PatientProfile,
  mechanisms: Mechanism[],
  previousAttempt: SearchStrategy | null,
): string {
  // Active conditions only — historical / resolved conditions don't drive
  // trial search. Mirrors the convention in identify-relevant-mechanisms.
  const conditions = profile.conditions
    .filter(isActiveCondition)
    .map((c) => `- ${c.display} (SNOMED ${c.code}, status: ${c.clinicalStatus ?? "unspecified"})`)
    .join("\n");

  const mechBlock = mechanisms
    .map((m) => {
      const genes = m.geneTargets.slice(0, GENES_PER_PROMPT).map((g) => g.name).join(", ");
      const paths = m.pathways.slice(0, PATHWAYS_PER_PROMPT).map((p) => p.name).join(", ");
      const rationale = m.rationale ? `\n    context: ${m.rationale}` : "";
      return `- ${m.conditionName}\n    genes: ${genes || "(none)"}\n    pathways: ${paths || "(none)"}${rationale}`;
    })
    .join("\n");

  // Active or in-progress medications only. Stopped/completed agents are
  // history, surfaced via priorTreatments. We render display only — the LLM
  // doesn't need RxNorm to reason about line of therapy.
  const activeMeds = profile.medications
    .filter(isActiveMedication)
    .map((m) => `- ${m.display}`)
    .join("\n");

  const priorTx = profile.priorTreatments
    .map((p) => `- ${p.display}${p.date ? ` (${p.date})` : ""}`)
    .join("\n");

  const demographics = `age: ${profile.ageYears}, sex: ${profile.sex}`;

  const previousBlock = previousAttempt
    ? `\nPrevious attempt (attempt ${previousAttempt.attempt}):\n  queries: ${previousAttempt.queries.join(" | ")}\n  filters: ${JSON.stringify(previousAttempt.filters)}\n  broadeningApplied: ${previousAttempt.broadeningApplied.join("; ") || "(none)"}\n`
    : "";

  const instructions = previousAttempt
    ? `${FIRST_ATTEMPT_INSTRUCTIONS}\n\n${BROADENING_INSTRUCTIONS}`
    : FIRST_ATTEMPT_INSTRUCTIONS;

  return `Patient demographics:
${demographics}

Patient conditions:
${conditions || "(none)"}

Patient mechanisms:
${mechBlock || "(none)"}

Active medications:
${activeMeds || "(none — treatment-naive)"}

Prior treatments:
${priorTx || "(none recorded)"}
${previousBlock}
${instructions}`;
}
