import { z } from "zod";
import { PatientProfileSchema } from "./patient";
import { MechanismDropSchema, MechanismSchema } from "./mechanism";
import { RepurposingCandidateSchema } from "./repurposing";
import { SearchStrategySchema } from "./search";
import { CandidateDropSchema, TrialCandidateSchema, TrialMatchSchema } from "./trial";
import { ApprovalRequestSchema } from "./run";

// Canonical shape of the agent's run state — both the source of truth for
// what flows over the SSE stream and the contract the agent's
// `AgentState` annotation is compile-time-checked against. Keep this in
// lockstep with apps/agent/src/state.ts; the compat check in that file
// will fail typecheck if either side drifts.
export const GraphStateSchema = z.object({
  patientId: z.string(),
  patientProfile: PatientProfileSchema.nullable(),
  mechanisms: z.array(MechanismSchema),
  mechanismDrops: z.array(MechanismDropSchema),
  repurposingCandidates: z.array(RepurposingCandidateSchema),
  searchStrategy: SearchStrategySchema.nullable(),
  candidates: z.array(TrialCandidateSchema),
  candidateDrops: z.array(CandidateDropSchema),  // NEW
  matches: z.array(TrialMatchSchema),
  attempts: z.number().int().nonnegative(),
  approvalRequest: ApprovalRequestSchema.nullable(),
  error: z.string().nullable(),
});
export type GraphState = z.infer<typeof GraphStateSchema>;
