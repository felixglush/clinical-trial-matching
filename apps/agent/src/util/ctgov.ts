// Small helpers shared by `tools/clinicaltrials.ts` (where CT.gov v2
// payloads are mapped into `TrialCandidate`) and `nodes/pre-filter.ts`
// (where Stage 1 deterministic gates inspect the same fields).

// CT.gov v2 `overallStatus` values that count as "enrolling-ish" for
// pre-filter's Stage 1 status gate. ACTIVE_NOT_RECRUITING is included
// because trials in that state sometimes resume; the LLM stage and
// downstream eligibility analysis can refine.
export const ENROLLING_STATUSES = new Set<string>([
  "RECRUITING",
  "ENROLLING_BY_INVITATION",
  "NOT_YET_RECRUITING",
  "ACTIVE_NOT_RECRUITING",
]);

export function isEnrollingStatus(status: string): boolean {
  return ENROLLING_STATUSES.has(status);
}

// Parses CT.gov's age strings into years (number). Returns undefined for
// missing, "N/A", or unparseable inputs — caller treats undefined as
// "no constraint" (lenient: don't drop on a parse failure we don't
// understand).
//
// CT.gov mostly emits "<N> Years" or "<N> Months", but newborn / infant
// trials use Weeks, Days, Hours, even Minutes (one-in-a-thousand). The
// unit list here was sampled from a 1000-study survey of the v2 API; see
// docs/ctgov-api-shape.md.
export function parseAgeYears(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (raw === "N/A") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s+(Years?|Months?|Weeks?|Days?|Hours?|Minutes?)$/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith("year"))   return n;
  if (unit.startsWith("month"))  return n / 12;
  if (unit.startsWith("week"))   return n / 52.1775;
  if (unit.startsWith("day"))    return n / 365.25;
  if (unit.startsWith("hour"))   return n / (365.25 * 24);
  if (unit.startsWith("minute")) return n / (365.25 * 24 * 60);
  return undefined;
}
