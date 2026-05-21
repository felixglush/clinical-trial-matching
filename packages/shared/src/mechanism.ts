import { z } from "zod";

export const KGNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["drug", "disease", "gene_protein", "biological_process"]),
  name: z.string(),
});
export type KGNode = z.infer<typeof KGNodeSchema>;

export const KGEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string(),
});
export type KGEdge = z.infer<typeof KGEdgeSchema>;

export const KGPathSchema = z.object({
  nodes: z.array(KGNodeSchema),
  edges: z.array(KGEdgeSchema),
});
export type KGPath = z.infer<typeof KGPathSchema>;

export const MechanismSchema = z.object({
  conditionId: z.string(),
  conditionName: z.string(),
  geneTargets: z.array(KGNodeSchema),
  pathways: z.array(KGNodeSchema),
  supportingPaths: z.array(KGPathSchema),
  rationale: z.string(),
});
export type Mechanism = z.infer<typeof MechanismSchema>;

// Why a condition that the patient has didn't end up in `state.mechanisms`.
// Surfaced so the UI can show users "we considered N conditions, kept K,
// and dropped these for these reasons" — the value here is auditability,
// not error reporting.
export const MechanismDropReasonSchema = z.enum([
  // clinicalStatus was resolved / inactive / remission / etc.
  "inactive",
  // SNOMED code wasn't in the SNOMED→PrimeKG crosswalk (no MONDO entry,
  // or a "finding" / "situation" with no disease equivalent).
  "unresolved",
  // Resolved + queried the KG, but the LLM ranking step didn't include
  // it in the top-K picks.
  "not-picked",
]);
export type MechanismDropReason = z.infer<typeof MechanismDropReasonSchema>;

export const MechanismDropSchema = z.object({
  code: z.string(),
  display: z.string(),
  reason: MechanismDropReasonSchema,
  // Free-text context (clinical status string, etc.) for debugging.
  detail: z.string().optional(),
});
export type MechanismDrop = z.infer<typeof MechanismDropSchema>;
