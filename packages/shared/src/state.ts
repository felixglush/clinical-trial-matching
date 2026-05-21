import { z } from "zod";
import { PatientProfileSchema } from "./patient";
import { MechanismSchema } from "./mechanism";
import { RepurposingCandidateSchema } from "./repurposing";
import { SearchStrategySchema } from "./search";
import { TrialCandidateSchema, TrialMatchSchema } from "./trial";
import { ApprovalRequestSchema } from "./run";

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
