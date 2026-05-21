import { z } from "zod";
import { KGNodeSchema, KGPathSchema } from "./mechanism";

export const RepurposingCandidateSchema = z.object({
  drug: KGNodeSchema,
  originalIndications: z.array(z.string()),
  rationale: z.string(),
  supportingPaths: z.array(KGPathSchema),
});
export type RepurposingCandidate = z.infer<typeof RepurposingCandidateSchema>;

export const RepurposingRationaleSchema = z.object({
  drugName: z.string(),
  originalIndications: z.array(z.string()),
  summary: z.string(),
});
export type RepurposingRationale = z.infer<typeof RepurposingRationaleSchema>;
