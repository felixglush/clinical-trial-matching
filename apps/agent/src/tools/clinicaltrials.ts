/**
 * # tools/clinicaltrials
 *
 * Thin async wrapper around ClinicalTrials.gov v2 REST API. No SDK; plain
 * `fetch`. One typed entry point `searchClinicalTrials(q)` that the
 * `search-trials` node calls for both the search-strategy channel (via
 * `q.term`) and the repurposing channel (via `q.intervention`). The two
 * fields are mutually exclusive — the caller picks one; the tool never
 * combines them.
 *
 * ## Rate limits and retries
 *
 * CT.gov does not publish a hard rate limit ("exists but generous" per
 * the v2 NLM bulletin and community docs). We don't know the bucket, so
 * we keep concurrency low at the node level (max 14 in-flight calls per
 * patient run) and retry transient 429 / 503 responses with exponential
 * backoff. If `Retry-After` is present we honor it (RFC 9110: integer
 * seconds or HTTP-date); otherwise we use 1s / 2s / 4s. After 3 attempts
 * the failure surfaces — the node's `Promise.allSettled` soft-degrades
 * that channel without killing the run.
 *
 * No global token bucket. If we see 429s in practice we add one then;
 * YAGNI until then.
 *
 * ## Field projection
 *
 * CT.gov v2 returns very large records by default. We pass `fields=` to
 * keep responses lean. Two separate field lists: `TRIAL_CANDIDATE_FIELDS`
 * for `searchClinicalTrials` (only what `TrialCandidate` carries) and
 * `TERMINATED_TRIAL_FIELDS` for `searchTerminatedPriorTrials` (lean to its
 * `PriorTerminatedTrial` consumer).
 *
 * ## Pagination
 *
 * `pageSize` defaults to 50 for `searchClinicalTrials` and 20 for
 * `searchTerminatedPriorTrials`; we never walk `nextPageToken`.
 */

import type {
  PriorTerminatedTrial,
  SearchFilters,
  TrialCandidate,
  TrialLocation,
} from "@clinical-trial-matching/shared";
import { parseAgeYears } from "../util/ctgov.js";

const BASE_URL = "https://clinicaltrials.gov/api/v2/studies";
const DEFAULT_PAGE_SIZE = 50;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 503]);

const TRIAL_CANDIDATE_FIELDS = [
  "protocolSection.identificationModule.nctId",
  "protocolSection.identificationModule.briefTitle",
  "protocolSection.statusModule.overallStatus",
  "protocolSection.descriptionModule.briefSummary",
  "protocolSection.conditionsModule.conditions",
  "protocolSection.designModule.phases",
  "protocolSection.armsInterventionsModule.interventions",
  "protocolSection.eligibilityModule.eligibilityCriteria",
  "protocolSection.eligibilityModule.minimumAge",
  "protocolSection.eligibilityModule.maximumAge",
  "protocolSection.eligibilityModule.stdAges",
  "protocolSection.eligibilityModule.sex",
  "protocolSection.contactsLocationsModule.locations",
].join("|");

const TERMINATED_TRIAL_FIELDS = [
  "protocolSection.identificationModule.nctId",
  "protocolSection.identificationModule.briefTitle",
  "protocolSection.statusModule.overallStatus",
  "protocolSection.statusModule.whyStopped",
  "protocolSection.statusModule.completionDateStruct.date",
  "protocolSection.conditionsModule.conditions",
  "protocolSection.designModule.phases",
  "protocolSection.armsInterventionsModule.interventions",
].join("|");

export type CtgQuery = {
  term?: string;
  intervention?: string;
  filters?: SearchFilters;
  pageSize?: number;
};

export async function searchClinicalTrials(q: CtgQuery): Promise<TrialCandidate[]> {
  const url = buildUrl(q);
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`CT.gov ${res.status} for ${url}`);
  }
  const body = (await res.json()) as CtgResponse;
  return (body.studies ?? []).map(toTrialCandidate);
}

const TERMINATED_PAGE_SIZE = 20;
const TERMINATED_STATUSES = "TERMINATED|WITHDRAWN|SUSPENDED";

export async function searchTerminatedPriorTrials(
  args: { intervention: string; condition: string; pageSize?: number },
): Promise<PriorTerminatedTrial[]> {
  const params = new URLSearchParams();
  params.set("query.intr", args.intervention);
  params.set("query.term", args.condition);
  params.set("filter.overallStatus", TERMINATED_STATUSES);
  params.set("pageSize", String(args.pageSize ?? TERMINATED_PAGE_SIZE));
  params.set("fields", TERMINATED_TRIAL_FIELDS);
  const url = `${BASE_URL}?${params.toString()}`;

  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`CT.gov ${res.status} for ${url}`);
  const body = (await res.json()) as CtgResponse;
  return (body.studies ?? []).flatMap(toPriorTerminatedTrial);
}

// Returns [] (not [partial]) if the study lacks an nctId or has an
// overallStatus we don't recognize as a terminated variant. flatMap drops
// the empty arrays cleanly.
function toPriorTerminatedTrial(study: CtgStudy): PriorTerminatedTrial[] {
  const p = study.protocolSection ?? {};
  const nctId = p.identificationModule?.nctId;
  const status = p.statusModule?.overallStatus;
  if (!nctId || (status !== "TERMINATED" && status !== "WITHDRAWN" && status !== "SUSPENDED")) {
    return [];
  }
  return [{
    nctId,
    briefTitle: p.identificationModule?.briefTitle ?? "",
    conditions: p.conditionsModule?.conditions ?? [],
    interventions: (p.armsInterventionsModule?.interventions ?? [])
      .map((i) => i.name)
      .filter((n): n is string => typeof n === "string"),
    phase: p.designModule?.phases?.[0],
    status,
    whyStopped: p.statusModule?.whyStopped,
    completionDate: p.statusModule?.completionDateStruct?.date,
  }];
}

function buildUrl(q: CtgQuery): string {
  const params = new URLSearchParams();
  if (q.term) params.set("query.term", q.term);
  if (q.intervention) params.set("query.intr", q.intervention);
  if (q.filters?.status && q.filters.status.length > 0) {
    params.set("filter.overallStatus", q.filters.status.join("|"));
  }
  if (q.filters?.phase && q.filters.phase.length > 0) {
    // CT.gov v2 has no `filter.phase` — phase is filtered via the
    // `filter.advanced` Essie expression. One phase: `AREA[Phase]PHASE2`;
    // multiple: `AREA[Phase](PHASE2 OR PHASE3)`.
    const phaseExpr =
      q.filters.phase.length === 1
        ? `AREA[Phase]${q.filters.phase[0]}`
        : `AREA[Phase](${q.filters.phase.join(" OR ")})`;
    params.set("filter.advanced", phaseExpr);
  }
  if (q.filters?.country) params.set("query.locn", q.filters.country);
  params.set("pageSize", String(q.pageSize ?? DEFAULT_PAGE_SIZE));
  params.set("fields", TRIAL_CANDIDATE_FIELDS);
  return `${BASE_URL}?${params.toString()}`;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Per-attempt timeout: a hung connection on one attempt shouldn't
    // exhaust the budget for the next. Throws AbortError on expiry,
    // which propagates out (we don't retry network-level failures).
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!RETRYABLE_STATUSES.has(res.status)) return res;
    lastRes = res;
    if (attempt === MAX_RETRIES - 1) break;
    const wait =
      parseRetryAfter(res.headers.get("retry-after")) ??
      BASE_BACKOFF_MS * 2 ** attempt;
    console.warn(
      `ctgov: ${res.status} on ${url}, backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
    );
    await sleep(wait);
  }
  return lastRes!;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CtgStudy = {
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string };
    statusModule?: {
      overallStatus?: string;
      whyStopped?: string;
      completionDateStruct?: { date?: string };
    };
    descriptionModule?: { briefSummary?: string };
    conditionsModule?: { conditions?: string[] };
    designModule?: { phases?: string[] };
    armsInterventionsModule?: { interventions?: Array<{ name?: string }> };
    eligibilityModule?: {
      eligibilityCriteria?: string;
      minimumAge?: string;
      maximumAge?: string;
      stdAges?: string[];
      sex?: string;
    };
    contactsLocationsModule?: {
      locations?: Array<{
        facility?: string;
        city?: string;
        state?: string;
        country?: string;
        status?: string;
      }>;
    };
  };
};

type CtgResponse = { studies?: CtgStudy[] };

// Builds a TrialCandidate WITHOUT the provenance fields (`discoveredVia`,
// `repurposingDrugIds`) — the caller attaches those at union time. We
// return a partially-typed object that downstream completes.
function toTrialCandidate(study: CtgStudy): TrialCandidate {
  const p = study.protocolSection ?? {};
  const interventions = (p.armsInterventionsModule?.interventions ?? [])
    .map((i) => i.name)
    .filter((n): n is string => typeof n === "string");
  const locations: TrialLocation[] = (
    p.contactsLocationsModule?.locations ?? []
  ).map((l) => ({
    facility: l.facility,
    city: l.city,
    state: l.state,
    country: l.country,
    status: l.status,
  }));
  const sex = p.eligibilityModule?.sex;
  const sexEligibility =
    sex === "ALL" || sex === "MALE" || sex === "FEMALE" ? sex : undefined;

  const minimumAge = p.eligibilityModule?.minimumAge;
  const maximumAge = p.eligibilityModule?.maximumAge;
  const rawStdAges = p.eligibilityModule?.stdAges ?? [];
  const stdAges = rawStdAges.filter(
    (s): s is "CHILD" | "ADULT" | "OLDER_ADULT" =>
      s === "CHILD" || s === "ADULT" || s === "OLDER_ADULT",
  );

  // Cast: discoveredVia / repurposingDrugIds intentionally omitted here;
  // the search-trials node attaches them. Keeping them off the tool's
  // output keeps responsibilities clean.
  return {
    nctId: p.identificationModule?.nctId ?? "",
    title: p.identificationModule?.briefTitle ?? "",
    briefSummary: p.descriptionModule?.briefSummary,
    conditions: p.conditionsModule?.conditions ?? [],
    interventions,
    phase: p.designModule?.phases?.[0],
    status: p.statusModule?.overallStatus ?? "",
    eligibilityCriteriaText: p.eligibilityModule?.eligibilityCriteria,
    locations,
    minimumAge,
    maximumAge,
    minimumAgeYears: parseAgeYears(minimumAge),
    maximumAgeYears: parseAgeYears(maximumAge),
    stdAges,
    sexEligibility,
  } as TrialCandidate;
}
