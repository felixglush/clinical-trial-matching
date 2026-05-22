import { Annotation } from "@langchain/langgraph";
import type {
  ApprovalRequest,
  CandidateDrop,
  GraphState,
  Mechanism,
  MechanismDrop,
  PatientProfile,
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
  TrialMatch,
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
  // Conditions on the patient profile that did not make it into `mechanisms`,
  // with a reason. Populated by identify-relevant-mechanisms so the UI can
  // surface "considered N, kept K, dropped these" for auditability.
  mechanismDrops: Annotation<MechanismDrop[]>({
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
  candidateDrops: Annotation<CandidateDrop[]>({
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

// Compile-time guard: AgentStateType must match the shared GraphState
// snapshot (the SSE stream contract). If either side adds, removes, or
// retypes a field without the other following, this assignment fails to
// compile — that's the point. Update both files in the same change.
//
// Bidirectional via the `Equal` pattern: if `AgentStateType` and
// `GraphState` are not mutually assignable, the conditional resolves to
// `never` and the const can't be initialized to `true`.
type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _AgentStateMatchesGraphState: _Equal<AgentStateType, GraphState> = true;
