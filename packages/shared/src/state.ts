import { z } from "zod";
import { PatientProfileSchema } from "./patient.js";
import { MechanismSchema } from "./mechanism.js";
import { RepurposingCandidateSchema } from "./repurposing.js";
import { SearchStrategySchema } from "./search.js";
import { TrialCandidateSchema, TrialMatchSchema } from "./trial.js";
import { ApprovalRequestSchema } from "./run.js";

export const GraphStateSchema = z.object({
  patientId: z.string(),
  patientProfile: PatientProfileSchema.nullable(),
  mechanisms: z.array(MechanismSchema),
  repurposingCandidates: z.array(RepurposingCandidateSchema),
  searchStrategy: SearchStrategySchema.nullable(),
  candidates: z.array(TrialCandidateSchema),
  matches: z.array(TrialMatchSchema),
  attempts: z.number().int().nonnegative(),
  approvalRequest: ApprovalRequestSchema.nullable(),
  error: z.string().nullable(),
});
export type GraphState = z.infer<typeof GraphStateSchema>;
