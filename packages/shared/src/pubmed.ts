import { z } from "zod";

export const CitationSchema = z.object({
  pmid: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  abstractExcerpt: z.string().optional(),
  pubtype: z.array(z.string()).default([]),
  url: z.url(),
});
export type Citation = z.infer<typeof CitationSchema>;
