import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState } from "./state.js";
import { eligibilityCheck } from "./nodes/eligibility-check.js";
import { mechanismPlausibility } from "./nodes/mechanism-plausibility.js";
import { literatureSupport } from "./nodes/literature-support.js";
import { decideIfMoreEvidence } from "./nodes/decide-if-more-evidence.js";
import { gatherCounterEvidence } from "./nodes/gather-counter-evidence.js";
import { synthesizeMatch } from "./nodes/synthesize-match.js";

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("eligibility-check", eligibilityCheck)
  .addNode("literature-support", literatureSupport)
  .addNode("gather-counter-evidence", gatherCounterEvidence)
  .addNode("mechanism-plausibility", mechanismPlausibility)
  .addNode("synthesize-match", synthesizeMatch)
  .addEdge(START, "eligibility-check")
  // Fan out: literature-support (with decide-if-more cycle) and
  // gather-counter-evidence run in parallel. Both fan in to
  // mechanism-plausibility, which sees both literatureSupport and
  // structuredCounterEvidence.
  .addEdge("eligibility-check", "literature-support")
  .addEdge("eligibility-check", "gather-counter-evidence")
  .addConditionalEdges("literature-support", decideIfMoreEvidence, [
    "literature-support",
    "mechanism-plausibility",
  ])
  .addEdge("gather-counter-evidence", "mechanism-plausibility")
  .addEdge("mechanism-plausibility", "synthesize-match")
  .addEdge("synthesize-match", END)
  .compile();
