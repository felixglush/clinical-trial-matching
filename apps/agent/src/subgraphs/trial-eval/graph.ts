import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState } from "./state.js";
import { eligibilityCheck } from "./nodes/eligibility-check.js";
import { mechanismPlausibility } from "./nodes/mechanism-plausibility.js";
import { literatureSupport } from "./nodes/literature-support.js";
import { decideIfMoreEvidence } from "./nodes/decide-if-more-evidence.js";
import { synthesizeMatch } from "./nodes/synthesize-match.js";

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("eligibility-check", eligibilityCheck)
  .addNode("literature-support", literatureSupport)
  .addNode("mechanism-plausibility", mechanismPlausibility)
  .addNode("synthesize-match", synthesizeMatch)
  .addEdge(START, "eligibility-check")
  .addEdge("eligibility-check", "literature-support")
  .addConditionalEdges("literature-support", decideIfMoreEvidence, [
    "literature-support",
    "mechanism-plausibility",
  ])
  .addEdge("mechanism-plausibility", "synthesize-match")
  .addEdge("synthesize-match", END)
  .compile();
