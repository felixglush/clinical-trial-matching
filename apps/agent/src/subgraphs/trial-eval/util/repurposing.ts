import type { RepurposingCandidate } from "@clinical-trial-matching/shared";

// Picks the RepurposingCandidate matching one of `drugIds`, preferring
// the highest `predIndication` when more than one matches. Shared between
// `mechanism-plausibility` (Path A / repurposing-context handling) and
// `gather-counter-evidence` (which surfaces the source's
// `predContraindication` as a structured counter-evidence signal).
// Returns undefined when no candidate matches.
export function pickSource(
  drugIds: readonly string[],
  candidates: RepurposingCandidate[],
): RepurposingCandidate | undefined {
  const matching = candidates.filter((rc) => drugIds.includes(rc.drug.id));
  if (matching.length === 0) return undefined;
  return matching.reduce((best, c) =>
    (c.predIndication ?? 0) > (best.predIndication ?? 0) ? c : best,
  );
}
