export const TIER1_PUBTYPES = new Set([
  "Randomized Controlled Trial",
  "Meta-Analysis",
  "Systematic Review",
]);
export const TIER3_PUBTYPES = new Set([
  "Case Reports",
  "Editorial",
  "Comment",
  "Letter",
  "News",
  "Personal Narrative",
]);

export type EvidenceTier = 1 | 2 | 3;

export function tierForCitation(c: { pubtype: readonly string[] }): EvidenceTier {
  for (const t of c.pubtype) {
    if (TIER1_PUBTYPES.has(t)) return 1;
  }
  for (const t of c.pubtype) {
    if (TIER3_PUBTYPES.has(t)) return 3;
  }
  return 2;
}

export function tierLabel(t: EvidenceTier): string {
  return t === 1
    ? "Tier-1 (RCT / meta-analysis / systematic review)"
    : t === 2
      ? "Tier-2 (clinical / review evidence)"
      : "Tier-3 (anecdotal / opinion)";
}
