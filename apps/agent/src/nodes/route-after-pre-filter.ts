import { Send } from "@langchain/langgraph";
import type { AgentStateType } from "../state.js";

// Cost-control thresholds for the prototype.
// MIN_CANDIDATES: only broaden the search if pre-filter yielded zero hits.
// MAX_ATTEMPTS:   give up after this many broaden-and-retry passes.
// MAX_EVALUATIONS: cap how many candidates fan out into the expensive
//                  trial-eval-subgraph. Each evaluation does multiple LLM
//                  calls (eligibility, mechanism plausibility, literature)
//                  and PubMed lookups, so this is the main cost knob.
const MIN_CANDIDATES = 1;
const MAX_ATTEMPTS = 3;
const MAX_EVALUATIONS = 5;

export function routeAfterPreFilter(
  state: AgentStateType,
): "generate-search-strategy" | Send[] {
  const shouldBroaden =
    state.candidates.length < MIN_CANDIDATES && state.attempts < MAX_ATTEMPTS;

  if (shouldBroaden) {
    return "generate-search-strategy";
  }

  if (!state.patientProfile) {
    throw new Error("patientProfile must be set before fan-out");
  }

  const profile = state.patientProfile;
  const mechanisms = state.mechanisms;
  const repurposingCandidates = state.repurposingCandidates;
  return state.candidates
    .slice(0, MAX_EVALUATIONS)
    .map(
      (candidate) =>
        new Send("trial-eval-subgraph", {
          patientProfile: profile,
          candidate,
          mechanisms,
          repurposingCandidates,
        }),
    );
}
