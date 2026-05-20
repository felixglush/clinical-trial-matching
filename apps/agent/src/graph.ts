import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { extractPatientProfile } from "./nodes/extract-patient-profile.js";
import { identifyRelevantMechanisms } from "./nodes/identify-relevant-mechanisms.js";
import { findRepurposingCandidates } from "./nodes/find-repurposing-candidates.js";
import { generateSearchStrategy } from "./nodes/generate-search-strategy.js";
import { searchTrials } from "./nodes/search-trials.js";
import { preFilter } from "./nodes/pre-filter.js";
import { routeAfterPreFilter } from "./nodes/route-after-pre-filter.js";
import { rankAndSynthesize } from "./nodes/rank-and-synthesize.js";
import { humanApproval } from "./nodes/human-approval.js";
import { trialEvalGraph } from "./subgraphs/trial-eval/graph.js";

export const graph = new StateGraph(AgentState)
  .addNode("extract-patient-profile", extractPatientProfile)
  .addNode("identify-relevant-mechanisms", identifyRelevantMechanisms)
  .addNode("find-repurposing-candidates", findRepurposingCandidates)
  .addNode("generate-search-strategy", generateSearchStrategy)
  .addNode("search-trials", searchTrials)
  .addNode("pre-filter", preFilter)
  .addNode("trial-eval-subgraph", trialEvalGraph)
  .addNode("rank-and-synthesize", rankAndSynthesize)
  .addNode("human-approval", humanApproval)
  .addEdge(START, "extract-patient-profile")
  .addEdge("extract-patient-profile", "identify-relevant-mechanisms")
  .addEdge("identify-relevant-mechanisms", "find-repurposing-candidates")
  .addEdge("identify-relevant-mechanisms", "generate-search-strategy")
  .addEdge("find-repurposing-candidates", "search-trials")
  .addEdge("generate-search-strategy", "search-trials")
  .addEdge("search-trials", "pre-filter")
  .addConditionalEdges("pre-filter", routeAfterPreFilter, [
    "generate-search-strategy",
    "trial-eval-subgraph",
  ])
  .addEdge("trial-eval-subgraph", "rank-and-synthesize")
  .addEdge("rank-and-synthesize", "human-approval")
  .addEdge("human-approval", END)
  .compile();
