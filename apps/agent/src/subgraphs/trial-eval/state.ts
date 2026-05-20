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

  match: Annotation<TrialMatch | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type TrialEvalStateType = typeof TrialEvalState.State;
