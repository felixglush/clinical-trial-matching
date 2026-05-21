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
