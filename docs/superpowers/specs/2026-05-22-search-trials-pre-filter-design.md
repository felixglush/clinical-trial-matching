# `search-trials` and `pre-filter`: Design

**Date:** 2026-05-22
**Status:** Draft (pending user review)
**Scope:** Implement the two graph nodes that sit between the mechanism-feed
layer and the per-trial evaluation subgraph: discovery of trial candidates
from ClinicalTrials.gov, then a cheap pre-filter. Also covers the real CT.gov
v2 REST client (currently a throwing stub) and small shared utilities that
both nodes use.

## Scope

**In scope:**

- `apps/agent/src/tools/clinicaltrials.ts` — real CT.gov v2 REST client with
  429/503 retry + exponential backoff.
- `apps/agent/src/nodes/search-trials.ts` — dual-channel discovery
  (search-strategy + repurposing), union + dedupe by `nctId`, attach
  provenance.
- `apps/agent/src/nodes/pre-filter.ts` — two-stage filter: deterministic
  gates, then bounded-concurrency LLM-as-judge on survivors. Persists
  `candidateDrops` for auditability.
- `apps/agent/src/prompts/pre-filter.ts` — real prompt + structured-output
  schema.
- `apps/agent/src/util/ctgov.ts` — age parser, status mapping.
- `apps/agent/src/util/concurrency.ts` — `mapWithConcurrency` helper used by
  both `search-trials` and `pre-filter`.
- Schema extension: `TrialCandidate` gains `discoveredVia`,
  `repurposingDrugIds`, `minimumAge`, `maximumAge`, `sexEligibility`. New
  `CandidateDrop` schema + enum. State gains `candidateDrops`.

**Out of scope:**

- `routeAfterPreFilter` body changes — current `MIN_CANDIDATES = 1` stays.
- `trial-eval` enrichment that consumes `discoveredVia` / `repurposingDrugIds`
  (covered by `2026-05-21-drug-eval-subgraph-design.md`).
- `rank-and-synthesize` appendix that consumes `repurposingDrugIds` (same
  drug-eval spec).
- Patient location / country gate (no patient location on `PatientProfile`
  today).
- Global token-bucket rate limiter for CT.gov (YAGNI until we observe 429s).

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Provenance tracking | Fields on `TrialCandidate` (`discoveredVia`, `repurposingDrugIds`) | Survives later refactors; downstream reads off the candidate without parallel state. |
| Per-repurposing-candidate CT.gov query | `intervention=<drug.name>` only (no condition narrowing) | Off-label trials are the whole point of the repurposing channel; condition narrowing would kill the signal. Pre-filter + trial-eval do the narrowing downstream. |
| Pre-filter logic | Stage 1 deterministic gates + Stage 2 LLM-as-judge | Hard rules (age/sex/status) are free and unambiguous; LLM handles only narrative criteria. Cuts LLM volume by ~half on common cases. |
| Pre-filter concurrency | Bounded async pool, cap 10 | ~5× speedup over sequential without bursting OpenRouter rate caps. |
| Search-strategy multi-query | One CT.gov call per `SearchStrategy.queries[i]`, parallel, union | Matches how the LLM was prompted to think about each query as self-contained. |
| Broaden-loop threshold | `MIN_CANDIDATES = 1` (unchanged) | Only broaden on a true zero. Avoids extra LLM/CT.gov spend on thin-but-nonzero results. |
| Per-CT.gov-query cap | `pageSize = 50` | Matches the drug-eval spec's starting point. Single page; no `nextPageToken` walking. |
| CT.gov 429/503 handling | Built into the client, not the node | Retry-on-transient is an HTTP-layer concern; the node sees success-or-throw. Retry budget: 3 attempts, backoff 1s/2s/4s, honoring `Retry-After` if present. |
| Drop-on-LLM-failure policy | Lenient: keep on error, `console.warn`, no entry in `candidateDrops` | The audit log is for "we dropped X because Y" — keeping isn't dropping. False negatives are more expensive than false positives at this stage. |
| `candidateDrops` persistence | New top-level state field, mirrors `mechanismDrops` shape | Auditability the user explicitly asked for; consistent with existing pattern. |

## Architecture

```text
state.searchStrategy.queries (1–4)         state.repurposingCandidates (≤50)
        │                                         │
        │                                         │
   N strategy calls                          M intervention-only calls
   (CT.gov v2, parallel,                     (CT.gov v2, parallel,
    pageSize=50)                              cap=10, pageSize=50)
        │                                         │
        └────── union, dedupe by nctId ──────────┘
                attach discoveredVia + repurposingDrugIds
                        │
                        ▼
                state.candidates : TrialCandidate[]
                        │
                        ▼
                  pre-filter
                  ├─ Stage 1: deterministic gates
                  │   (status / age / sex / deceased)
                  │   drops → candidateDrops (stage:"stage1")
                  └─ Stage 2: bounded LLM-as-judge on survivors
                      (cap=10; "when in doubt, keep")
                      drops → candidateDrops (stage:"stage2")
                        │
                        ▼
                state.candidates (kept) + state.candidateDrops (audit)
```

## CT.gov client (`tools/clinicaltrials.ts`)

Thin async wrapper around CT.gov's v2 REST API. No SDK; plain `fetch`. Module
constants for base URL and default page size.

**Endpoint:** `GET https://clinicaltrials.gov/api/v2/studies`

**One typed entry point:**

```ts
export type CtgQuery = {
  term?: string;         // → query.term (search-strategy channel)
  intervention?: string; // → query.intr  (repurposing channel)
  filters?: SearchFilters;
  pageSize?: number;     // default 50
};

export async function searchClinicalTrials(q: CtgQuery): Promise<TrialCandidate[]>;
```

Caller picks `term` xor `intervention`; the function never combines them
itself. The two channels stay separate and are unioned by the node.

**Request mapping:**

| `CtgQuery` field | CT.gov v2 param |
|---|---|
| `term` | `query.term` |
| `intervention` | `query.intr` |
| `filters.status[]` | `filter.overallStatus` (pipe-joined) |
| `filters.phase[]` | `filter.phase` (pipe-joined) |
| `filters.country` | `query.locn` |
| `pageSize` (≤50) | `pageSize` |
| always | `fields=…` (projection — only the fields we use) |

**Response → `TrialCandidate`:** parse v2 `studies[]` and extract `nctId`,
`briefTitle`, `briefSummary`, `conditions`, `interventions[].name`, `phases`,
`overallStatus`, `eligibilityCriteria`, `locations`, plus the new fields
`minimumAge`, `maximumAge`, `sexEligibility`. The tool **does not** set
`discoveredVia` or `repurposingDrugIds` — the node attaches those at union
time.

### 429 / 503 retry

Built into the client; the node sees success-or-throw, no special-casing.

```ts
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt === MAX_RETRIES - 1) return res; // give up; caller sees the status
    const retryAfterMs =
      parseRetryAfter(res.headers.get("retry-after")) ?? BASE_BACKOFF_MS * 2 ** attempt;
    await sleep(retryAfterMs);
  }
  throw new Error("unreachable");
}
```

`Retry-After` parsing follows RFC 9110: integer-seconds or HTTP-date. Missing
or unparseable → fallback to exponential backoff `1s → 2s → 4s`. Total
worst-case retry budget per call: ~7s.

`fetchWithRetry` is a private helper that returns whatever `Response` it
ends up with. The public `searchClinicalTrials` checks `res.ok` and throws on
non-2xx — so a 429 that persists past all 3 retries surfaces as a thrown
error, and the node's `Promise.allSettled` soft-degrades that channel.

503 follows the same code path — CT.gov has been observed to return transient
503s during maintenance.

Per retry: `console.warn` with context
(`"ctgov: 429 on intervention=<drug>, backing off Xms (attempt N/3)"`).

**No global token bucket.** Natural fan-out structure already caps in-flight
calls (max 4 strategy + 10 repurposing = 14). Documented in the file header;
revisit if we observe 429s in practice.

### Testing

`tools/clinicaltrials.test.ts`, `vi.spyOn(global, "fetch")` returns fixture v2
payloads.

- Well-formed response → correct mapping (all fields including new ones).
- Empty `studies[]` → `[]`.
- 500 status → throws.
- 429 then 200 → returns the 200 (one retry; fake timers).
- 429 with `Retry-After: 2` → waits ~2s, retries.
- 429 × 3 → returns the final 429 to the caller.
- 503 follows the same retry path.

## `nodes/search-trials.ts`

```ts
export async function searchTrials(state): Promise<Partial<AgentStateType>> {
  const strategy = state.searchStrategy;
  if (!strategy) return { error: "No search strategy available" };

  const [strategyResult, repurposingResult] = await Promise.allSettled([
    runStrategyChannel(strategy),
    runRepurposingChannel(state.repurposingCandidates),
  ]);

  const strategyHits = unwrapOrWarn(strategyResult, "strategy");
  const repurposingHits = unwrapOrWarn(repurposingResult, "repurposing");

  if (strategyHits.length === 0 && repurposingHits.length === 0) {
    if (strategyResult.status === "rejected" && repurposingResult.status === "rejected") {
      return { error: "Failed to query CT.gov: both channels errored" };
    }
    return { candidates: [] };
  }

  return { candidates: unionAndDedupe(strategyHits, repurposingHits) };
}
```

**Strategy channel.** For each of 1–4 `strategy.queries`, one CT.gov call with
`term=<query>`, `filters=strategy.filters`, `pageSize=50`. All parallel via
`Promise.allSettled`. Per-query failure → `console.warn`, keep going. Returns
`Array<{ candidate: TrialCandidate, channel: "strategy" }>`.

**Repurposing channel.** For each `repurposingCandidate`,
`intervention=<drug.name>` with the same filters and pageSize. Bounded
concurrency via `mapWithConcurrency(candidates, 10, ...)`. Per-call failure →
`console.warn`, keep going. Returns `Array<{ candidate: TrialCandidate,
channel: "repurposing", drugId: string }>`.

**Union + dedupe + provenance:**

```ts
function unionAndDedupe(strategyHits, repurposingHits): TrialCandidate[] {
  const byNctId = new Map<string, TrialCandidate>();
  for (const { candidate } of strategyHits) {
    byNctId.set(candidate.nctId, {
      ...candidate,
      discoveredVia: ["strategy"],
      repurposingDrugIds: [],
    });
  }
  for (const { candidate, drugId } of repurposingHits) {
    const existing = byNctId.get(candidate.nctId);
    if (existing) {
      if (!existing.discoveredVia.includes("repurposing")) {
        existing.discoveredVia.push("repurposing");
      }
      if (!existing.repurposingDrugIds.includes(drugId)) {
        existing.repurposingDrugIds.push(drugId);
      }
    } else {
      byNctId.set(candidate.nctId, {
        ...candidate,
        discoveredVia: ["repurposing"],
        repurposingDrugIds: [drugId],
      });
    }
  }
  return [...byNctId.values()];
}
```

`drugId` (not name) flows into `repurposingDrugIds[]` — stable across name
aliases, looks up cleanly against `state.repurposingCandidates`.

### Error model

| Condition | Behavior |
|---|---|
| `searchStrategy` null | `{error: "No search strategy available"}` |
| Single CT.gov call fails | warn-log, drop that call's contribution |
| All strategy calls fail AND all repurposing calls fail | `{error: …}` |
| Either channel has ≥1 hit | success; partial loss tolerated |
| No `repurposingCandidates` | repurposing channel returns `[]`; strategy channel still runs |

### Testing

`nodes/search-trials.test.ts`, `vi.spyOn` on `searchClinicalTrials`.

- Trial only in strategy channel → `discoveredVia: ["strategy"]`,
  `repurposingDrugIds: []`.
- Trial only in repurposing channel → `discoveredVia: ["repurposing"]`,
  `repurposingDrugIds: ["DRUG_X"]`.
- Trial in both → `discoveredVia: ["strategy","repurposing"]`,
  `repurposingDrugIds: ["DRUG_X"]`.
- Trial returned by two different repurposing candidates → one entry,
  `repurposingDrugIds: ["DRUG_X","DRUG_Y"]`.
- One channel rejects → other still produces candidates; warn logged.
- Both channels reject → `{error}` returned.
- No `repurposingCandidates` → strategy-only candidates.

## `nodes/pre-filter.ts` and `prompts/pre-filter.ts`

### Stage 1 — deterministic gates

Drop a candidate if any rule fires. Pure functions on `TrialCandidate` +
`PatientProfile`.

| Gate | Drop reason | Logic |
|---|---|---|
| Status not enrolling-ish | `not-recruiting` | `status` ∉ `{RECRUITING, ENROLLING_BY_INVITATION, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING}` |
| Age below minimum | `age-too-young` | Parse `minimumAge` (e.g. `"18 Years"`); compare to `profile.ageYears`. Missing/unparseable → skip rule. |
| Age above maximum | `age-too-old` | Same logic for `maximumAge`. |
| Sex mismatch | `sex-mismatch` | `sexEligibility === "MALE"` and `profile.sex !== "male"` (and vice versa). `"ALL"`, unset, or `profile.sex ∈ {other, unknown}` → skip rule. |
| Patient deceased | `deceased` | `profile.deceased === true`. Edge case; fixtures may trip it. |

Notes:

- **Country / geographic** is not a Stage-1 gate. Patient country isn't on
  `PatientProfile`; defer.
- Age parser lives in `util/ctgov.ts`. Handles `"N Years"`, `"N Months"`,
  `"N/A"`; anything else → no constraint (lenient).
- Stage 1 summary `console.info`:
  `"pre-filter stage 1: 73 in, 41 kept, drops: not-recruiting=20, age-too-young=8, sex-mismatch=4"`.

### Stage 2 — LLM-as-judge on survivors

Per surviving candidate, one structured-output Haiku call.

```ts
const PreFilterJudgmentSchema = z.object({
  keep: z.boolean(),
  reason: z.string(), // short, empty when keep=true
});
```

**Prompt** (`prompts/pre-filter.ts`):

```
You're triaging a clinical trial against a patient profile. Drop the trial
ONLY if there's an obvious eligibility blocker visible in the brief
eligibility text. When in doubt, KEEP — a downstream expensive eligibility
checker will analyze in detail.

Patient:
  - age <N>, sex <S>
  - active conditions: <comma-separated displays>
  - active medications: <comma-separated displays>
  - prior treatments: <comma-separated displays>

Trial:
  - title: <title>
  - conditions: <conditions>
  - interventions: <interventions>
  - eligibility criteria (excerpt, first 2000 chars):
    <eligibilityCriteriaText>

Return keep=true unless one of these is clear from the text above:
  - patient lacks a required prior therapy
  - patient has an excluded condition or excluded prior therapy
  - patient is in an excluded subpopulation (e.g. pregnant, organ failure)

reason: short phrase explaining the call. Empty string if keep=true.
```

"When in doubt, keep" — the expensive `trial-eval` eligibility node does
per-criterion analysis. Pre-filter only cuts the obvious losers.

**Eligibility-text truncation.** CT.gov eligibility blobs can run several
KB. Truncate to 2000 chars in the prompt. Constant `ELIGIBILITY_EXCERPT_CHARS
= 2000` lives in the prompt module. `trial-eval` reads the full text from the
candidate, so truncation only affects pre-filter judgment.

### Concurrency

`mapWithConcurrency(survivors, 10, askLlm)`. The helper lives in
`util/concurrency.ts` (no new dep) and is shared with `search-trials`.

### Node output

```ts
return {
  candidates: kept,
  candidateDrops: drops, // both stages, ordered
};
```

`state.candidates` is overwritten with survivors. A broaden loop replaces
both `candidates` and `candidateDrops` on its second pre-filter call.

### Error model

| Condition | Behavior |
|---|---|
| `patientProfile` null | `{error: "No patient profile available"}` |
| `candidates` empty | `{candidates: [], candidateDrops: []}`; `routeAfterPreFilter` broadens. |
| Stage 2 LLM fails on one candidate | Keep candidate (lenient); `console.warn`; no entry in `candidateDrops`. |
| All Stage 2 calls fail | Return Stage 1 survivors as-is; warn-log; degraded but workable. |

### Testing

`nodes/pre-filter.test.ts`, mocks `../llm.js` per existing pattern.

- Stage 1 drops: fixture with one trial per drop reason → each gets dropped
  with the right `reason`, `stage: "stage1"`, and a `detail` matching the
  gate that fired:
  - `not-recruiting`: `detail` = the raw `status` value.
  - `age-too-young` / `age-too-old`: `detail` = the raw `minimumAge` /
    `maximumAge` string (e.g. `"18 Years"`).
  - `sex-mismatch`: `detail` = the trial's `sexEligibility`.
  - `deceased`: `detail` omitted.
- Stage 2 drops: mock LLM returns `{keep:false, reason:"..."}` → candidate
  ends up in `candidateDrops` with `reason: "llm-ineligible"`, `stage:
  "stage2"`, `detail` = LLM's free-text.
- Empty `candidates` → `{candidates:[], candidateDrops:[]}`, no LLM call.
- LLM failure on one candidate → still in `candidates`, NOT in
  `candidateDrops`. Assert both.
- Patient profile null → `{error: ...}`.
- Concurrency: spy counter + delays on 25 candidates → max-in-flight ≤ 10.

## Schema changes

**`packages/shared/src/trial.ts`:**

```ts
// TrialCandidateSchema additions:
minimumAge: z.string().optional(),
maximumAge: z.string().optional(),
sexEligibility: z.enum(["ALL", "MALE", "FEMALE"]).optional(),
discoveredVia: z.array(z.enum(["strategy", "repurposing"])).nonempty(),
repurposingDrugIds: z.array(z.string()),

// New:
export const CANDIDATE_DROP_REASONS = [
  { value: "not-recruiting",   label: "Not recruiting" },
  { value: "age-too-young",    label: "Age below minimum" },
  { value: "age-too-old",      label: "Age above maximum" },
  { value: "sex-mismatch",     label: "Sex mismatch" },
  { value: "deceased",         label: "Patient deceased" },
  { value: "llm-ineligible",   label: "LLM judged ineligible" },
] as const;

export type CandidateDropReason = (typeof CANDIDATE_DROP_REASONS)[number]["value"];
export const CandidateDropReasonSchema = z.enum(
  CANDIDATE_DROP_REASONS.map(r => r.value) as [CandidateDropReason, ...CandidateDropReason[]],
);

export const CandidateDropSchema = z.object({
  nctId: z.string(),
  title: z.string(),
  reason: CandidateDropReasonSchema,
  detail: z.string().optional(),
  stage: z.enum(["stage1", "stage2"]),
});
export type CandidateDrop = z.infer<typeof CandidateDropSchema>;
```

`TrialMatchSchema` extends `TrialCandidateSchema` and inherits the new fields
automatically.

**`packages/shared/src/state.ts`:** add
`candidateDrops: z.array(CandidateDropSchema)` to `GraphStateSchema`.

**`apps/agent/src/state.ts`:**

```ts
candidateDrops: Annotation<CandidateDrop[]>({
  reducer: (_prev, next) => next,
  default: () => [],
}),
```

Replace-on-write. Compile-time `_AgentStateMatchesGraphState` enforces parity.

## Topology doc update

`docs/topology.md`:

- Add `candidateDrops` row to the state table.
- Replace the `pre-filter` paragraph with the two-stage description.
- Note the new `TrialCandidate` fields (`discoveredVia`, `repurposingDrugIds`,
  age/sex fields) in the `search-trials` write list.

## File map

```
packages/shared/src/
├── trial.ts                                MODIFY (5 new fields, drop enum/schema)
└── state.ts                                MODIFY (candidateDrops)

apps/agent/src/
├── state.ts                                MODIFY (candidateDrops annotation)
├── tools/
│   ├── clinicaltrials.ts                   REWRITE (real v2 client with 429 retry)
│   └── clinicaltrials.test.ts              NEW
├── util/
│   ├── ctgov.ts                            NEW (parseAgeYears, status mapping)
│   ├── ctgov.test.ts                       NEW
│   ├── concurrency.ts                      NEW (mapWithConcurrency)
│   └── concurrency.test.ts                 NEW
├── nodes/
│   ├── search-trials.ts                    REWRITE
│   ├── search-trials.test.ts               NEW
│   ├── pre-filter.ts                       REWRITE
│   └── pre-filter.test.ts                  NEW
└── prompts/
    ├── pre-filter.ts                       REWRITE (real prompt + schema)
    └── pre-filter.test.ts                  NEW

docs/topology.md                            MODIFY
docs/superpowers/specs/2026-05-22-search-trials-pre-filter-design.md  NEW (this spec)
```

## Risks and open items

1. **Drug-name → CT.gov `query.intr` matching is imprecise.** TxGNN drug
   names (DrugBank-style) may not match CT.gov intervention text cleanly
   (brand vs. generic, salt forms). Already flagged in
   `2026-05-21-drug-eval-subgraph-design.md`. First runs will tell us if
   recall is acceptable; mitigation (RxNorm/DrugBank crosswalk) deferred.
2. **Age parsing edge cases.** CT.gov mostly emits `"N Years"` / `"N Months"`
   / `"N/A"`. We handle those three; anything else → no constraint (lenient).
3. **Eligibility-text truncation (2000 chars) can drop the actual blocker
   on long oncology trials.** Stage 2's "when in doubt, keep" tempers this —
   `trial-eval` sees full text downstream.
4. **No global token bucket for CT.gov.** Natural fan-out structure caps
   in-flight to ~14 calls. Add a real bucket if we observe 429s in practice.
5. **No documented CT.gov rate limit.** Primary sources (NLM v2 bulletin,
   community docs) describe limits as "exist but generous" with no published
   number. Our 429/503 retry handles them when they fire.
