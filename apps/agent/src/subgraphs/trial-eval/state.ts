import { Annotation } from "@langchain/langgraph";
import type {
  PatientProfile,
  TrialCandidate,
  TrialMatch,
  Mechanism,
  RepurposingCandidate,
  Citation,
  EligibilityAssessment,
} from "@clinical-trial-matching/shared";

export const TrialEvalState = Annotation.Root({
  patientProfile: Annotation<PatientProfile>,
  candidate: Annotation<TrialCandidate>,
  mechanisms: Annotation<Mechanism[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  repurposingCandidates: Annotation<RepurposingCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  eligibility: Annotation<EligibilityAssessment | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  mechanismScore: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  mechanismRationale: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  literatureSupport: Annotation<Citation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  evidenceAttempts: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  // Field name MUST match the parent graph's `matches: TrialMatch[]` so
  // LangGraph propagates this subgraph's result back through the parent
  // state. Concat reducer here is symmetric with the parent's reducer:
  // synthesize-match writes `{ matches: [theOneMatch] }`, this subgraph's
  // matches becomes `[theOneMatch]`, then the parent appends that array
  // to its own `matches` when this fan-out branch completes.
  matches: Annotation<TrialMatch[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

export type TrialEvalStateType = typeof TrialEvalState.State;
