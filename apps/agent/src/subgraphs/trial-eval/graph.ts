import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState } from "./state.js";
import { eligibilityCheck } from "./nodes/eligibility-check.js";
import { mechanismPlausibility } from "./nodes/mechanism-plausibility.js";
import { literatureSupport } from "./nodes/literature-support.js";
import { decideIfMoreEvidence } from "./nodes/decide-if-more-evidence.js";
import { synthesizeMatch } from "./nodes/synthesize-match.js";

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("eligibility-check", eligibilityCheck)
  .addNode("mechanism-plausibility", mechanismPlausibility)
  .addNode("literature-support", literatureSupport)
  .addNode("synthesize-match", synthesizeMatch)
  .addEdge(START, "eligibility-check")
  .addEdge("eligibility-check", "mechanism-plausibility")
  .addEdge("mechanism-plausibility", "literature-support")
  .addConditionalEdges("literature-support", decideIfMoreEvidence, [
    "literature-support",
    "synthesize-match",
  ])
  .addEdge("synthesize-match", END)
  .compile();
