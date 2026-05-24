import { Annotation } from "@langchain/langgraph";
import type {
  PatientProfile,
  TrialCandidate,
  TrialMatch,
  Mechanism,
  MechanismEvidenceItem,
  RepurposingCandidate,
  Citation,
  EligibilityAssessment,
} from "@clinical-trial-matching/shared";

// LangGraph annotations need a default value so parallel-fan-out branches
// can read state before any node has written it. For `eligibility` we use
// an "unclear" sentinel instead of `null` so downstream nodes (notably
// synthesize-match, which must always emit a TrialMatch with a non-null
// eligibility) can read it without null-guarding. eligibility-check
// overwrites this default with a real assessment on every path (including
// its LLM-failure fallback, which also resolves to overall="unclear").
export const EMPTY_UNCLEAR_ELIGIBILITY: EligibilityAssessment = {
  inclusion: [],
  exclusion: [],
  overall: "unclear",
  safetyConcerns: [],
};

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

  eligibility: Annotation<EligibilityAssessment>({
    reducer: (_prev, next) => next,
    default: () => EMPTY_UNCLEAR_ELIGIBILITY,
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
  counterEvidence: Annotation<Citation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  mechanismEvidence: Annotation<MechanismEvidenceItem[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  counterEvidenceAddressed: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
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
