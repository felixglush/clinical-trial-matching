import { z } from "zod";
import { TrialMatchSchema } from "./trial";

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ApprovalRequestSchema = z.object({
  patientId: z.string(),
  summary: z.string(),
  matches: z.array(TrialMatchSchema),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResponseSchema = z.object({
  action: z.enum(["approve", "reject", "edit"]),
  edits: z.array(TrialMatchSchema).optional(),
  notes: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;
