import { Annotation } from "@langchain/langgraph";
import type {
  PatientProfile,
  Mechanism,
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
  TrialMatch,
  ApprovalRequest,
} from "@clinical-trial-matching/shared";

export const AgentState = Annotation.Root({
  patientId: Annotation<string>,
  patientProfile: Annotation<PatientProfile | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  mechanisms: Annotation<Mechanism[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  repurposingCandidates: Annotation<RepurposingCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  searchStrategy: Annotation<SearchStrategy | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  candidates: Annotation<TrialCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  matches: Annotation<TrialMatch[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  attempts: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  approvalRequest: Annotation<ApprovalRequest | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;
