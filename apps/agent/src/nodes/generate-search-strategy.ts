/**
 * # generate-search-strategy
 *
 * LLM-driven generation of a `SearchStrategy` from the patient's profile
 * and identified mechanisms. Produces 1-4 ClinicalTrials.gov full-text
 * queries plus optional filters. On retries (when `state.searchStrategy`
 * is non-null) the model broadens the previous strategy and records what
 * it changed in `broadeningApplied`.
 *
 * ## Pipeline
 *
 * ```text
 *   state.patientProfile + state.mechanisms + state.searchStrategy?
 *       │
 *       │  searchStrategyPrompt(profile, mechanisms, previousAttempt)
 *       │    - demographics → filter hints (phase, country)
 *       │    - conditions  → query anchors
 *       │    - mechanisms  → gene/pathway query terms + clinical context
 *       │    - meds + priorTreatments → line-of-therapy qualifiers
 *       │    - previousAttempt (if any) → broadening instructions
 *       ▼
 *   llm.withStructuredOutput(SearchStrategyPickSchema).invoke(prompt)
 *       │  returns { queries, filters, broadeningApplied }
 *       ▼
 *   Compose SearchStrategy:
 *       - queries, filters, broadeningApplied   from the LLM
 *       - attempt = previousAttempt.attempt + 1 (or 1 if first call)
 *       ▼
 *   { searchStrategy, attempts: state.attempts + 1 }
 * ```
 *
 * ## Peer node
 *
 * `find-repurposing-candidates` runs concurrently downstream of
 * `identify-relevant-mechanisms` (see graph.ts). Both produce inputs for
 * `search-trials`, which unions their outputs by NCT id. This node does
 * not invoke CT.gov directly — only the query intent is generated here.
 *
 * ## Retry / broadening loop
 *
 * The graph's `pre-filter` may route back to this node when too few
 * candidates are found. `state.searchStrategy` carries the previous
 * attempt; the prompt's BROADENING_INSTRUCTIONS guide the model to relax
 * filters or generalize terms (never narrow). `attempt` increments per
 * call; `broadeningApplied` accumulates the audit trail of what changed.
 *
 * ## Error model
 *
 *   - state.patientProfile null              → {error: "No patient profile available"}
 *   - LLM API / structured-output failure    → {error: "Failed to generate search
 *                                                       strategy: ..."}
 *
 * Identical shape to identify-relevant-mechanisms's error returns. No
 * in-node retries — graph-level retry handles transients.
 */

import type {
  SearchStrategy,
} from "@clinical-trial-matching/shared";

import { llm } from "../llm.js";
import {
  SearchStrategyPickSchema,
  searchStrategyPrompt,
} from "../prompts/search-strategy.js";
import type { AgentStateType } from "../state.js";
import { errorMessage } from "../util/error.js";

export async function generateSearchStrategy(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const profile = state.patientProfile;
  if (!profile) {
    return { error: "No patient profile available" };
  }

  const nextAttempt = (state.searchStrategy?.attempt ?? 0) + 1;

  try {
    const structured = llm.withStructuredOutput(SearchStrategyPickSchema);
    const prompt = searchStrategyPrompt(profile, state.mechanisms, state.searchStrategy);
    const pick = await structured.invoke(prompt);

    const strategy: SearchStrategy = {
      queries: pick.queries,
      filters: pick.filters,
      attempt: nextAttempt,
      broadeningApplied: pick.broadeningApplied,
    };

    return {
      searchStrategy: strategy,
      attempts: state.attempts + 1,
    };
  } catch (err) {
    return {
      error: `Failed to generate search strategy: ${errorMessage(err)}`,
    };
  }
}
