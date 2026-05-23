# ClinicalTrials.gov v2 API — payload shape

What we read from CT.gov, how each field is encoded on the wire, and which fields drive logic in the agent. This is reference material for the v2 REST API at `https://clinicaltrials.gov/api/v2/studies`.

Our wrapper lives in [`apps/agent/src/tools/clinicaltrials.ts`](../apps/agent/src/tools/clinicaltrials.ts). The mapping into `TrialCandidate` (the canonical shape on `packages/shared`) happens in `toTrialCandidate` there. Pre-filter Stage 1 in [`apps/agent/src/nodes/pre-filter.ts`](../apps/agent/src/nodes/pre-filter.ts) is the main downstream consumer.

## Wire envelope

```
GET https://clinicaltrials.gov/api/v2/studies?<params>
→ 200 application/json
{
  "studies": [ { "protocolSection": { ... } }, ... ],
  "nextPageToken": "<opaque>"
}
```

We never walk `nextPageToken`; the per-query cap is `pageSize=50` (set in `clinicaltrials.ts`).

## Query parameters we use

| Param | Example | What it does |
|---|---|---|
| `query.term` | `query.term=type 2 diabetes` | Free-text search across the record |
| `query.intr` | `query.intr=metformin` | Free-text search restricted to interventions |
| `query.locn` | `query.locn=United States` | Free-text search on locations |
| `filter.overallStatus` | `filter.overallStatus=RECRUITING\|NOT_YET_RECRUITING` | Pipe-joined `OverallStatus` enum filter |
| `filter.advanced` | `filter.advanced=AREA[Phase](PHASE2 OR PHASE3)` | Essie expression — used for phase and could be used for `StdAge` |
| `fields` | (see `FIELDS` in `clinicaltrials.ts`) | Pipe-joined field projection to keep responses small |
| `pageSize` | `pageSize=50` | We never override |

**Phase note:** v2 has no `filter.phase`. Phase is filtered via the Essie expression `AREA[Phase]<value>` (single) or `AREA[Phase](<a> OR <b>)` (multiple). The mapping is in `buildUrl` and tested in `clinicaltrials.test.ts`.

**Retries:** 429 and 503 are retried with `Retry-After`-aware exponential backoff (1s / 2s / 4s, 3 attempts). All other non-2xx throws.

## Fields we read (`protocolSection.*`)

We pass `fields=` to project only what `TrialCandidate` carries. Anything not in this list is not requested. The current list:

```
protocolSection.identificationModule.nctId
protocolSection.identificationModule.briefTitle
protocolSection.statusModule.overallStatus
protocolSection.descriptionModule.briefSummary
protocolSection.conditionsModule.conditions
protocolSection.designModule.phases
protocolSection.armsInterventionsModule.interventions
protocolSection.eligibilityModule.eligibilityCriteria
protocolSection.eligibilityModule.minimumAge
protocolSection.eligibilityModule.maximumAge
protocolSection.eligibilityModule.stdAges
protocolSection.eligibilityModule.sex
protocolSection.contactsLocationsModule.locations
```

### identificationModule

```ts
{ nctId: string, briefTitle: string }
```

NCT id format: `NCT` + 8 digits. Treated as opaque.

### statusModule

```ts
{ overallStatus: OverallStatus }
```

`OverallStatus` enum — verified against the live `enums` endpoint, 14 values:

| Value | Trial state | Considered "enrolling" by us? |
|---|---|---|
| `RECRUITING` | Actively enrolling | ✓ |
| `ENROLLING_BY_INVITATION` | Selective enrollment | ✓ |
| `NOT_YET_RECRUITING` | Hasn't opened yet | ✓ |
| `ACTIVE_NOT_RECRUITING` | Ongoing, no longer accruing | ✓ (lenient — sometimes resumes) |
| `SUSPENDED` | Temporarily paused | ✗ |
| `COMPLETED` | Finished | ✗ |
| `TERMINATED` | Stopped early | ✗ |
| `WITHDRAWN` | Cancelled before opening | ✗ |
| `UNKNOWN` | Sponsor stopped reporting | ✗ |
| `WITHHELD` | Record blocked | ✗ |
| `AVAILABLE` | **Expanded access** open | ✗ (not interventional) |
| `NO_LONGER_AVAILABLE` | Expanded access closed | ✗ |
| `TEMPORARILY_NOT_AVAILABLE` | Expanded access paused | ✗ |
| `APPROVED_FOR_MARKETING` | Expanded access — drug approved | ✗ |

Source of truth for our "enrolling" set: `ENROLLING_STATUSES` in `apps/agent/src/util/ctgov.ts`.

### descriptionModule

```ts
{ briefSummary?: string }  // plain text, can include newlines
```

### conditionsModule

```ts
{ conditions: string[] }  // free-text MeSH-ish strings, not normalized
```

Examples: `"Type 2 Diabetes Mellitus"`, `"Breast Neoplasms"`. Not codes; do not match against ICD/SNOMED literally.

### designModule

```ts
{ phases: string[] }  // we use phases[0]
```

`Phase` enum values: `EARLY_PHASE1`, `PHASE1`, `PHASE1_PHASE2`, `PHASE2`, `PHASE2_PHASE3`, `PHASE3`, `PHASE4`, `NA`.

### armsInterventionsModule

```ts
{ interventions: Array<{ type?: string, name?: string, ... }> }
```

We only read `name`. `type` is one of `DRUG`, `BIOLOGICAL`, `DEVICE`, `PROCEDURE`, `RADIATION`, `BEHAVIORAL`, `GENETIC`, `DIETARY_SUPPLEMENT`, `COMBINATION_PRODUCT`, `DIAGNOSTIC_TEST`, `OTHER`.

### eligibilityModule

The most-consumed module. Shape:

```ts
{
  eligibilityCriteria?: string,   // markdown-ish free text
  healthyVolunteers?: boolean,
  sex?: "ALL" | "MALE" | "FEMALE",
  minimumAge?: string,            // see below
  maximumAge?: string,
  stdAges?: ("CHILD" | "ADULT" | "OLDER_ADULT")[],
  studyPopulation?: string,
  samplingMethod?: string,
}
```

#### Age fields (`minimumAge`, `maximumAge`)

Strings, always `<number> <unit>` shape. The unit can be — from a sample of 1000 studies (1460 populated age values):

| Unit | Count | Notes |
|---|---|---|
| `Years` / `Year` | 1426 | adult/pediatric mainstream |
| `Months` / `Month` | 33 | infant/pediatric |
| `Weeks` | 7 | neonate |
| `Days` / `Day` | 10 | neonate |
| `Hours` | 1 | newborn (hours-old) |
| `Minutes` | (seen in smaller samples) | moment-of-birth trials |

`"N/A"` is also valid (means "no constraint specified").

We parse these to numeric years in `parseAgeYears` (`apps/agent/src/util/ctgov.ts`) at the ingest boundary (`toTrialCandidate`) and store the result on `TrialCandidate.minimumAgeYears` / `maximumAgeYears`. The raw string is also retained for display in audit drops.

**Unparseable units fall back to `undefined`** ("no constraint"). That's lenient by design, with one caveat: a `maximumAge` that fails to parse on a real neonate-only trial would let adults through pre-filter's numeric gate. We protect against this with `stdAges` (next field) as a coarse pre-check.

#### `stdAges`

CT.gov's own categorical age bucketing — an array of:

- `CHILD` (0–17)
- `ADULT` (18–64)
- `OLDER_ADULT` (65+)

A trial with `maximumAge: "48 Hours"` is tagged `stdAges: ["CHILD"]` by CT.gov, regardless of whether our regex understands "48 Hours". This is **the load-bearing age gate** in pre-filter Stage 1 — the numeric compare is the precision pass, not the safety net.

Also queryable: `filter.advanced=AREA[StdAge]ADULT` (single) or `AREA[StdAge](ADULT OR OLDER_ADULT)` (multiple). Not currently used at query time; could be added to narrow search responses if traffic shape ever motivates it.

### contactsLocationsModule

```ts
{
  locations?: Array<{
    facility?: string,
    city?: string,
    state?: string,
    country?: string,
    status?: string,  // per-site status string, not the same enum as overallStatus
  }>
}
```

Site `status` is a free-form string in practice (`"Recruiting"`, `"Active, not recruiting"`, `"Withdrawn"`, etc., with different capitalization than `OverallStatus`). Treated as display data, not used for filtering.

## TrialCandidate mapping summary

`toTrialCandidate` (`apps/agent/src/tools/clinicaltrials.ts`) flattens the above into:

```ts
{
  nctId: string,                                              // identificationModule.nctId
  title: string,                                              // identificationModule.briefTitle
  briefSummary?: string,                                      // descriptionModule.briefSummary
  conditions: string[],                                       // conditionsModule.conditions
  interventions: string[],                                    // armsInterventionsModule.interventions[].name
  phase?: string,                                             // designModule.phases[0]
  status: string,                                             // statusModule.overallStatus
  eligibilityCriteriaText?: string,                           // eligibilityModule.eligibilityCriteria
  locations: TrialLocation[],                                 // contactsLocationsModule.locations
  minimumAge?: string,                                        // raw, display only
  maximumAge?: string,                                        // raw, display only
  minimumAgeYears?: number,                                   // parsed at ingest, drives pre-filter
  maximumAgeYears?: number,                                   // parsed at ingest, drives pre-filter
  stdAges: ("CHILD" | "ADULT" | "OLDER_ADULT")[],            // primary age gate
  sexEligibility?: "ALL" | "MALE" | "FEMALE",                 // eligibilityModule.sex
  discoveredVia: ("strategy" | "repurposing")[],              // attached by search-trials node
  repurposingDrugIds: string[],                               // attached by search-trials node
}
```

## Pre-filter Stage 1 gates (which fields they read)

| Gate | Fields | Notes |
|---|---|---|
| `deceased` | `PatientProfile.deceased` | Drops every trial, no field reads |
| `not-recruiting` | `status` | Compared against `ENROLLING_STATUSES` |
| `age-too-young` / `age-too-old` (categorical) | `stdAges`, `PatientProfile.ageYears` | Fires when patient's bucket is disjoint from trial's |
| `age-too-young` / `age-too-old` (numeric) | `minimumAgeYears`, `maximumAgeYears`, `PatientProfile.ageYears` | Boundary cases within the same bucket |
| `sex-mismatch` | `sexEligibility`, `PatientProfile.sex` | Patient sex of `unknown` / `other` skips the gate (lenient) |

## Useful CT.gov references

- API root: <https://clinicaltrials.gov/api/v2/studies>
- Enum listing: <https://clinicaltrials.gov/api/v2/studies/enums>
- Study data structure: <https://clinicaltrials.gov/data-api/about-api/study-data-structure>
- Essie query language (used by `filter.advanced`): <https://clinicaltrials.gov/data-api/about-api/search-areas>
