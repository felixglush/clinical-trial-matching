import { Send } from "@langchain/langgraph";
import type { AgentStateType } from "../state.js";

const MIN_CANDIDATES = 5;
const MAX_ATTEMPTS = 3;

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
  return state.candidates.map(
    (candidate) =>
      new Send("trial-eval-subgraph", {
        patientProfile: profile,
        candidate,
        mechanisms,
        repurposingCandidates,
      }),
  );
}
