import { z } from "zod";
import { KGNodeSchema, KGPathSchema } from "./mechanism";

export const RepurposingCandidateSchema = z.object({
  drug: KGNodeSchema,
  originalIndications: z.array(z.string()),
  rationale: z.string(),
  supportingPaths: z.array(KGPathSchema),
  // Populated when the candidate came from a TxGNN lookup. Optional because
  // a future non-TxGNN producer (manual entry, alternate model) wouldn't have
  // these. Range: [0, 1].
  predIndication: z.number().min(0).max(1).optional(),
  predContraindication: z.number().min(0).max(1).optional(),
});
export type RepurposingCandidate = z.infer<typeof RepurposingCandidateSchema>;

export const RepurposingRationaleSchema = z.object({
  drugName: z.string(),
  originalIndications: z.array(z.string()),
  summary: z.string(),
});
export type RepurposingRationale = z.infer<typeof RepurposingRationaleSchema>;
