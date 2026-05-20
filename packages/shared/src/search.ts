import { z } from "zod";

export const SearchFiltersSchema = z.object({
  status: z.array(z.enum(["RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION", "NOT_YET_RECRUITING"])).optional(),
  phase: z.array(z.enum(["PHASE1", "PHASE2", "PHASE3", "PHASE4", "EARLY_PHASE1", "NA"])).optional(),
  country: z.string().optional(),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const SearchStrategySchema = z.object({
  queries: z.array(z.string()).min(1),
  filters: SearchFiltersSchema,
  attempt: z.number().int().nonnegative(),
  broadeningApplied: z.array(z.string()),
});
export type SearchStrategy = z.infer<typeof SearchStrategySchema>;
