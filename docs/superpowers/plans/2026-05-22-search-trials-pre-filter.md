# `search-trials` and `pre-filter` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two stub nodes (`search-trials`, `pre-filter`) and the throwing CT.gov client (`tools/clinicaltrials.ts`) with real implementations: dual-channel CT.gov discovery with `nctId` dedup + provenance, then a two-stage (deterministic gates + bounded LLM-as-judge) pre-filter with persisted drop audit trail.

**Architecture:** Three layers, bottom up.

1. **HTTP layer (`tools/clinicaltrials.ts`):** thin `fetch` wrapper around CT.gov v2 REST, with 429/503 retry + RFC 9110 `Retry-After` honoring. Maps v2 `studies[]` payloads into `TrialCandidate` objects. The tool does NOT set provenance fields (`discoveredVia`, `repurposingDrugIds`) — those are attached by the caller node at union time.
2. **Discovery layer (`nodes/search-trials.ts`):** issues 1–4 search-strategy calls (one per `searchStrategy.queries[i]`) and 0–50 repurposing-channel calls (one per `repurposingCandidates[i].drug.name`), bounded-concurrency = 10 on the repurposing channel, unions both, dedupes by `nctId`, attaches provenance.
3. **Filter layer (`nodes/pre-filter.ts`):** Stage 1 deterministic gates (status / age / sex / deceased) write entries to `state.candidateDrops` (`stage:"stage1"`). Stage 2 runs the surviving candidates through a "when in doubt, keep" Haiku judgment, bounded-concurrency = 10, with drops written to `state.candidateDrops` (`stage:"stage2"`).

Shared helpers (`util/concurrency.ts`, `util/ctgov.ts`) factor logic used by both nodes.

**Tech Stack:** TypeScript (strict, `bundler` module resolution), Node 24, pnpm workspaces (exact-pinned deps), Zod 4.4.3, LangGraph.js 1.3.2, `@langchain/openai` 1.4.6 (Haiku via OpenRouter), vitest 4.1.7. No new runtime deps — `fetch` is built into Node 24.

**Spec:** `docs/superpowers/specs/2026-05-22-search-trials-pre-filter-design.md`. Every section of that spec maps to one or more tasks below.

**Conventions referenced:** `docs/codebase-conventions.md` (file layout, naming, error handling, test patterns), `CLAUDE.md` (exact-pinned versions — but this plan adds no deps). Test patterns mirror `apps/agent/src/nodes/generate-search-strategy.test.ts` for LLM-mocking and `apps/agent/src/nodes/find-repurposing-candidates.test.ts` for state-stubbing.

---

## File map

**Create:**
- `apps/agent/src/util/concurrency.ts` — `mapWithConcurrency` helper.
- `apps/agent/src/util/concurrency.test.ts` — bounded-concurrency assertions.
- `apps/agent/src/util/ctgov.ts` — `parseAgeYears`, status mapping helpers.
- `apps/agent/src/util/ctgov.test.ts` — unit tests.
- `apps/agent/src/tools/clinicaltrials.test.ts` — fetch-mocked unit tests.
- `apps/agent/src/tools/__fixtures__/ctgov-study-fixture.json` — one realistic CT.gov v2 study response.
- `apps/agent/src/nodes/search-trials.test.ts` — node tests (mock the tool).
- `apps/agent/src/nodes/pre-filter.test.ts` — node tests (mock LLM, real concurrency helper).
- `apps/agent/src/prompts/pre-filter.test.ts` — prompt-structure tests.

**Modify:**
- `packages/shared/src/trial.ts` — extend `TrialCandidateSchema`; add `CandidateDropSchema` + `CANDIDATE_DROP_REASONS`.
- `packages/shared/src/state.ts` — add `candidateDrops` to `GraphStateSchema`.
- `apps/agent/src/state.ts` — add `candidateDrops` Annotation.
- `apps/agent/src/tools/clinicaltrials.ts` — replace stub with real v2 client.
- `apps/agent/src/nodes/search-trials.ts` — replace stub with dual-channel discovery.
- `apps/agent/src/nodes/pre-filter.ts` — replace stub with two-stage filter.
- `apps/agent/src/prompts/pre-filter.ts` — replace stub with real prompt + schema.
- `docs/topology.md` — document new state field + node behaviors.

---

## Execution order

Bottom-up: schema → utils → HTTP → discovery → filter. Each task is independently committable and each task's tests pass before the next starts.

```
Task 1 (schema)              ──► Task 2 (state annotation)
                                       │
                                       ▼
Task 3 (concurrency util)    ──► Task 4 (ctgov util) ──► Task 5 (clinicaltrials tool)
                                       │                      │
                                       ▼                      ▼
                                Task 6 (search-trials node) ◄┘
                                       │
                                       ▼
Task 7 (pre-filter prompt) ──► Task 8 (pre-filter node)
                                       │
                                       ▼
                                Task 9 (topology doc)
```

---

## Task 1: Shared schema extensions

**Files:**
- Modify: `packages/shared/src/trial.ts`
- Modify: `packages/shared/src/state.ts`

### Step 1: Extend `TrialCandidateSchema`

Edit `packages/shared/src/trial.ts`. Replace the existing `TrialCandidateSchema` definition with:

```ts
export const TrialCandidateSchema = z.object({
  nctId: z.string(),
  title: z.string(),
  briefSummary: z.string().optional(),
  conditions: z.array(z.string()),
  interventions: z.array(z.string()),
  phase: z.string().optional(),
  status: z.string(),
  eligibilityCriteriaText: z.string().optional(),
  locations: z.array(TrialLocationSchema),
  // NEW: structured eligibility fields used by pre-filter Stage 1.
  minimumAge: z.string().optional(),      // CT.gov format: "18 Years"
  maximumAge: z.string().optional(),
  sexEligibility: z.enum(["ALL", "MALE", "FEMALE"]).optional(),
  // NEW: provenance. Every candidate is discovered via at least one
  // channel. `repurposingDrugIds` is empty when only the strategy channel
  // surfaced the trial; otherwise contains the `drug.id` values from
  // `state.repurposingCandidates` that produced the hit.
  discoveredVia: z.array(z.enum(["strategy", "repurposing"])).nonempty(),
  repurposingDrugIds: z.array(z.string()),
});
```

### Step 2: Add `CandidateDrop` schema

Append to `packages/shared/src/trial.ts`:

```ts
// Why a TrialCandidate didn't make it past pre-filter. Mirrors the
// MECHANISM_DROP_REASONS pattern in mechanism.ts — single source of truth
// for the enum, label, and display order. UIs iterate the array; the
// schema and type derive from it.
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
  CANDIDATE_DROP_REASONS.map((r) => r.value) as [
    CandidateDropReason,
    ...CandidateDropReason[],
  ],
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

### Step 3: Add `candidateDrops` to `GraphStateSchema`

Edit `packages/shared/src/state.ts`. Add the import and the field:

```ts
import { CandidateDropSchema, TrialCandidateSchema, TrialMatchSchema } from "./trial";
```

And inside `GraphStateSchema`, after the `candidates` line:

```ts
candidates: z.array(TrialCandidateSchema),
candidateDrops: z.array(CandidateDropSchema),  // NEW
matches: z.array(TrialMatchSchema),
```

### Step 4: Run typecheck — expect failures in agent state

```bash
pnpm -r typecheck
```

Expected: failures in `apps/agent/src/state.ts` because `AgentStateType` no longer matches `GraphState` (the `_Equal` guard fires). That's the next task. Schema-side typecheck within `packages/shared` should pass.

### Step 5: Commit

```bash
git add packages/shared/src/trial.ts packages/shared/src/state.ts
git commit -m "Add CandidateDrop + provenance/age fields to trial schemas"
```

---

## Task 2: Agent state annotation

**Files:**
- Modify: `apps/agent/src/state.ts`

### Step 1: Add the `candidateDrops` annotation

Edit `apps/agent/src/state.ts`. Add `CandidateDrop` to the imports from shared:

```ts
import type {
  ApprovalRequest,
  CandidateDrop,
  GraphState,
  Mechanism,
  MechanismDrop,
  PatientProfile,
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
  TrialMatch,
} from "@clinical-trial-matching/shared";
```

Insert the annotation after `candidates` (keep field order matching `GraphStateSchema` for review-ability):

```ts
  candidates: Annotation<TrialCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  candidateDrops: Annotation<CandidateDrop[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  matches: Annotation<TrialMatch[]>({
```

### Step 2: Run typecheck — expect success

```bash
pnpm -r typecheck
```

Expected: PASS. The `_Equal<AgentStateType, GraphState>` guard at the bottom of the file resolves to `true`.

### Step 3: Commit

```bash
git add apps/agent/src/state.ts
git commit -m "Add candidateDrops annotation to agent state"
```

---

## Task 3: `util/concurrency.ts` — `mapWithConcurrency`

**Files:**
- Create: `apps/agent/src/util/concurrency.ts`
- Create: `apps/agent/src/util/concurrency.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/util/concurrency.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in the same order as the input", async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("respects the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    await mapWithConcurrency(items, 10, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(10);
    expect(maxInFlight).toBeGreaterThan(1); // sanity check: not sequential
  });

  it("propagates rejections from the worker", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("returns [] for empty input without invoking the worker", async () => {
    let calls = 0;
    const out = await mapWithConcurrency<number, number>([], 10, async (n) => {
      calls += 1;
      return n;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/util/concurrency.test.ts
```

Expected: FAIL — `mapWithConcurrency` module doesn't exist.

### Step 3: Implement `mapWithConcurrency`

Create `apps/agent/src/util/concurrency.ts`:

```ts
// Bounded-concurrency Array.map. Preserves input order in the output.
// Workers are seeded with `limit` initial tasks; each completion picks up
// the next unstarted index. Rejections propagate; the helper doesn't
// catch.
//
// Used by `nodes/search-trials.ts` (repurposing channel) and
// `nodes/pre-filter.ts` (Stage 2 LLM-as-judge). Both want the same
// behavior so the helper lives here, not in the nodes.

export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const out: U[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/util/concurrency.test.ts
```

Expected: PASS, all 4 tests.

### Step 5: Commit

```bash
git add apps/agent/src/util/concurrency.ts apps/agent/src/util/concurrency.test.ts
git commit -m "Add util/concurrency: bounded-concurrency mapWithConcurrency"
```

---

## Task 4: `util/ctgov.ts` — age parser + status helpers

**Files:**
- Create: `apps/agent/src/util/ctgov.ts`
- Create: `apps/agent/src/util/ctgov.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/util/ctgov.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ENROLLING_STATUSES,
  isEnrollingStatus,
  parseAgeYears,
} from "./ctgov.js";

describe("parseAgeYears", () => {
  it("parses N Years", () => {
    expect(parseAgeYears("18 Years")).toBe(18);
    expect(parseAgeYears("75 Years")).toBe(75);
  });

  it("parses N Months as a fractional year", () => {
    expect(parseAgeYears("6 Months")).toBeCloseTo(0.5, 5);
    expect(parseAgeYears("24 Months")).toBeCloseTo(2, 5);
  });

  it("returns undefined for N/A", () => {
    expect(parseAgeYears("N/A")).toBeUndefined();
  });

  it("returns undefined for missing or unparseable strings", () => {
    expect(parseAgeYears(undefined)).toBeUndefined();
    expect(parseAgeYears("")).toBeUndefined();
    expect(parseAgeYears("18")).toBeUndefined();
    expect(parseAgeYears("eighteen years")).toBeUndefined();
  });
});

describe("isEnrollingStatus", () => {
  it("returns true for enrolling-ish statuses", () => {
    for (const s of ENROLLING_STATUSES) {
      expect(isEnrollingStatus(s)).toBe(true);
    }
  });

  it("returns false for non-enrolling statuses", () => {
    expect(isEnrollingStatus("COMPLETED")).toBe(false);
    expect(isEnrollingStatus("WITHDRAWN")).toBe(false);
    expect(isEnrollingStatus("TERMINATED")).toBe(false);
    expect(isEnrollingStatus("SUSPENDED")).toBe(false);
  });

  it("returns false for empty / unknown strings", () => {
    expect(isEnrollingStatus("")).toBe(false);
    expect(isEnrollingStatus("not a real status")).toBe(false);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/util/ctgov.test.ts
```

Expected: FAIL — `ctgov` module doesn't exist.

### Step 3: Implement the helpers

Create `apps/agent/src/util/ctgov.ts`:

```ts
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
// CT.gov mostly emits "<N> Years" or "<N> Months"; "N/A" is also common.
// Anything else hits the lenient fallback.
export function parseAgeYears(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (raw === "N/A") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s+(Years?|Months?)$/.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2]!.startsWith("Month") ? n / 12 : n;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/util/ctgov.test.ts
```

Expected: PASS, all 11 assertions across the 8 test cases.

### Step 5: Commit

```bash
git add apps/agent/src/util/ctgov.ts apps/agent/src/util/ctgov.test.ts
git commit -m "Add util/ctgov: age parser + enrolling-status helper"
```

---

## Task 5: `tools/clinicaltrials.ts` — real v2 REST client

**Files:**
- Modify: `apps/agent/src/tools/clinicaltrials.ts`
- Create: `apps/agent/src/tools/clinicaltrials.test.ts`
- Create: `apps/agent/src/tools/__fixtures__/ctgov-study-fixture.json`

### Step 1: Create the response fixture

Create `apps/agent/src/tools/__fixtures__/ctgov-study-fixture.json`. This is one realistic CT.gov v2 study record, used by every test in this task:

```json
{
  "studies": [
    {
      "protocolSection": {
        "identificationModule": {
          "nctId": "NCT00000001",
          "briefTitle": "A Study of Drug X in Type 2 Diabetes"
        },
        "statusModule": {
          "overallStatus": "RECRUITING"
        },
        "descriptionModule": {
          "briefSummary": "Phase 2 trial of drug X for adults with T2DM."
        },
        "conditionsModule": {
          "conditions": ["Type 2 Diabetes Mellitus"]
        },
        "designModule": {
          "phases": ["PHASE2"]
        },
        "armsInterventionsModule": {
          "interventions": [
            { "type": "DRUG", "name": "Drug X" },
            { "type": "DRUG", "name": "Metformin" }
          ]
        },
        "eligibilityModule": {
          "eligibilityCriteria": "Inclusion: adults 18-75 with T2DM.\nExclusion: pregnancy.",
          "minimumAge": "18 Years",
          "maximumAge": "75 Years",
          "sex": "ALL"
        },
        "contactsLocationsModule": {
          "locations": [
            {
              "facility": "Site A",
              "city": "Boston",
              "state": "MA",
              "country": "United States",
              "status": "RECRUITING"
            }
          ]
        }
      }
    }
  ]
}
```

### Step 2: Write failing tests

Create `apps/agent/src/tools/clinicaltrials.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchClinicalTrials } from "./clinicaltrials.js";
import fixture from "./__fixtures__/ctgov-study-fixture.json" with { type: "json" };

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("searchClinicalTrials", () => {
  it("maps a v2 study payload into a TrialCandidate", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse(fixture));
    const [t] = await searchClinicalTrials({ term: "type 2 diabetes" });
    expect(t.nctId).toBe("NCT00000001");
    expect(t.title).toBe("A Study of Drug X in Type 2 Diabetes");
    expect(t.status).toBe("RECRUITING");
    expect(t.phase).toBe("PHASE2");
    expect(t.conditions).toEqual(["Type 2 Diabetes Mellitus"]);
    expect(t.interventions).toEqual(["Drug X", "Metformin"]);
    expect(t.minimumAge).toBe("18 Years");
    expect(t.maximumAge).toBe("75 Years");
    expect(t.sexEligibility).toBe("ALL");
    expect(t.eligibilityCriteriaText).toContain("Inclusion: adults");
    expect(t.locations).toHaveLength(1);
    expect(t.locations[0]!.city).toBe("Boston");
  });

  it("does not populate discoveredVia or repurposingDrugIds (caller does)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse(fixture));
    const [t] = await searchClinicalTrials({ term: "x" });
    // The tool's return type carries the fields, but they should be absent
    // at runtime — the node attaches them at union time.
    expect((t as Partial<typeof t>).discoveredVia).toBeUndefined();
    expect((t as Partial<typeof t>).repurposingDrugIds).toBeUndefined();
  });

  it("sends query.term for a term query", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ term: "diabetes" });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("query.term")).toBe("diabetes");
    expect(url.searchParams.get("query.intr")).toBeNull();
  });

  it("sends query.intr for an intervention query", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ intervention: "metformin" });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("query.intr")).toBe("metformin");
    expect(url.searchParams.get("query.term")).toBeNull();
  });

  it("pipe-joins status and phase filters", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({
      term: "x",
      filters: { status: ["RECRUITING", "NOT_YET_RECRUITING"], phase: ["PHASE2"] },
    });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("filter.overallStatus")).toBe("RECRUITING|NOT_YET_RECRUITING");
    expect(url.searchParams.get("filter.phase")).toBe("PHASE2");
  });

  it("defaults pageSize to 50", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ term: "x" });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("pageSize")).toBe("50");
  });

  it("returns [] for an empty studies array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    const out = await searchClinicalTrials({ term: "x" });
    expect(out).toEqual([]);
  });

  it("throws on non-2xx, non-retryable status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({}, { status: 500 }));
    await expect(searchClinicalTrials({ term: "x" })).rejects.toThrow(/500/);
  });

  it("retries on 429 then returns the 200", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse({}, { status: 429 }))
      .mockResolvedValueOnce(makeResponse(fixture));
    const promise = searchClinicalTrials({ term: "x" });
    // Advance past the first backoff (1s).
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After (seconds) on 429", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(
        makeResponse({}, { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(makeResponse(fixture));
    const promise = searchClinicalTrials({ term: "x" });
    // Should NOT resolve before ~2s.
    await vi.advanceTimersByTimeAsync(1000);
    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
  });

  it("gives up after 3 attempts and throws on persistent 429", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(makeResponse({}, { status: 429 }));
    const promise = searchClinicalTrials({ term: "x" });
    // 1s + 2s of backoff between 3 attempts.
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).rejects.toThrow(/429/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("treats 503 like 429 (retries)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse({}, { status: 503 }))
      .mockResolvedValueOnce(makeResponse(fixture));
    const promise = searchClinicalTrials({ term: "x" });
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out).toHaveLength(1);
  });
});
```

### Step 3: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/tools/clinicaltrials.test.ts
```

Expected: FAIL — the existing `searchClinicalTrials` is a throwing stub.

### Step 4: Implement the real client

Replace `apps/agent/src/tools/clinicaltrials.ts` entirely:

```ts
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
 * keep responses lean — only what `TrialCandidate` carries.
 *
 * ## Pagination
 *
 * `pageSize` defaults to 50; we never walk `nextPageToken`. Top-50 per
 * query is the spec's cap.
 */

import type {
  SearchFilters,
  TrialCandidate,
  TrialLocation,
} from "@clinical-trial-matching/shared";

const BASE_URL = "https://clinicaltrials.gov/api/v2/studies";
const DEFAULT_PAGE_SIZE = 50;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 503]);

const FIELDS = [
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
  "protocolSection.eligibilityModule.sex",
  "protocolSection.contactsLocationsModule.locations",
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

function buildUrl(q: CtgQuery): string {
  const params = new URLSearchParams();
  if (q.term) params.set("query.term", q.term);
  if (q.intervention) params.set("query.intr", q.intervention);
  if (q.filters?.status && q.filters.status.length > 0) {
    params.set("filter.overallStatus", q.filters.status.join("|"));
  }
  if (q.filters?.phase && q.filters.phase.length > 0) {
    params.set("filter.phase", q.filters.phase.join("|"));
  }
  if (q.filters?.country) params.set("query.locn", q.filters.country);
  params.set("pageSize", String(q.pageSize ?? DEFAULT_PAGE_SIZE));
  params.set("fields", FIELDS);
  return `${BASE_URL}?${params.toString()}`;
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url);
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
    statusModule?: { overallStatus?: string };
    descriptionModule?: { briefSummary?: string };
    conditionsModule?: { conditions?: string[] };
    designModule?: { phases?: string[] };
    armsInterventionsModule?: { interventions?: Array<{ name?: string }> };
    eligibilityModule?: {
      eligibilityCriteria?: string;
      minimumAge?: string;
      maximumAge?: string;
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
    minimumAge: p.eligibilityModule?.minimumAge,
    maximumAge: p.eligibilityModule?.maximumAge,
    sexEligibility,
  } as TrialCandidate;
}
```

### Step 5: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/tools/clinicaltrials.test.ts
```

Expected: PASS, all 12 test cases.

### Step 6: Commit

```bash
git add apps/agent/src/tools/clinicaltrials.ts apps/agent/src/tools/clinicaltrials.test.ts apps/agent/src/tools/__fixtures__/ctgov-study-fixture.json
git commit -m "Implement CT.gov v2 REST client with 429/503 retry"
```

---

## Task 6: `nodes/search-trials.ts` — dual-channel discovery + provenance

**Files:**
- Modify: `apps/agent/src/nodes/search-trials.ts`
- Create: `apps/agent/src/nodes/search-trials.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/nodes/search-trials.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchTrials } from "./search-trials.js";
import type { AgentStateType } from "../state.js";
import type {
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as ctgov from "../tools/clinicaltrials.js";

afterEach(() => vi.restoreAllMocks());

function strategy(queries: string[]): SearchStrategy {
  return {
    queries,
    filters: { status: ["RECRUITING"] },
    attempt: 1,
    broadeningApplied: [],
  };
}

function repurposing(drugId: string, drugName: string): RepurposingCandidate {
  return {
    drug: { id: drugId, name: drugName, type: "drug" },
    originalIndications: ["x"],
    rationale: "",
    supportingPaths: [],
    predIndication: 0.9,
    predContraindication: 0.1,
  };
}

function trial(nctId: string): TrialCandidate {
  return {
    nctId,
    title: `Trial ${nctId}`,
    conditions: [],
    interventions: [],
    status: "RECRUITING",
    locations: [],
    // The tool returns these as undefined; assertions on them happen in
    // tool tests, not here.
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
  } as TrialCandidate;
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    searchStrategy: strategy(["t2dm"]),
    repurposingCandidates: [],
    ...overrides,
  } as unknown as AgentStateType;
}

describe("searchTrials", () => {
  it("returns {error} when searchStrategy is null", async () => {
    const out = await searchTrials(
      makeState({ searchStrategy: null }),
    );
    expect(out.error).toMatch(/search strategy/i);
  });

  it("attaches discoveredVia=['strategy'] to strategy-only hits", async () => {
    vi.spyOn(ctgov, "searchClinicalTrials").mockResolvedValue([trial("NCT1")]);
    const out = await searchTrials(makeState());
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.discoveredVia).toEqual(["strategy"]);
    expect(out.candidates![0]!.repurposingDrugIds).toEqual([]);
  });

  it("attaches discoveredVia=['repurposing'] + drug ids to repurposing-only hits", async () => {
    const spy = vi.spyOn(ctgov, "searchClinicalTrials");
    spy.mockImplementation(async (q) => {
      if (q.term) return [];
      if (q.intervention === "metformin") return [trial("NCT2")];
      return [];
    });
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    const c = out.candidates!.find((t) => t.nctId === "NCT2")!;
    expect(c.discoveredVia).toEqual(["repurposing"]);
    expect(c.repurposingDrugIds).toEqual(["DB00331"]);
  });

  it("unions both channels for a shared NCT id", async () => {
    const spy = vi.spyOn(ctgov, "searchClinicalTrials");
    spy.mockImplementation(async (q) => {
      if (q.term) return [trial("NCT3")];
      if (q.intervention === "metformin") return [trial("NCT3")];
      return [];
    });
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.discoveredVia.sort()).toEqual([
      "repurposing",
      "strategy",
    ]);
    expect(out.candidates![0]!.repurposingDrugIds).toEqual(["DB00331"]);
  });

  it("merges repurposingDrugIds when two candidates surface the same trial", async () => {
    vi.spyOn(ctgov, "searchClinicalTrials").mockImplementation(async (q) => {
      if (q.term) return [];
      if (q.intervention === "metformin") return [trial("NCT4")];
      if (q.intervention === "dapagliflozin") return [trial("NCT4")];
      return [];
    });
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [
          repurposing("DB00331", "metformin"),
          repurposing("DB06292", "dapagliflozin"),
        ],
      }),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.repurposingDrugIds.sort()).toEqual([
      "DB00331",
      "DB06292",
    ]);
  });

  it("issues one CT.gov call per query in searchStrategy.queries", async () => {
    const spy = vi.spyOn(ctgov, "searchClinicalTrials").mockResolvedValue([]);
    await searchTrials(
      makeState({ searchStrategy: strategy(["q1", "q2", "q3"]) }),
    );
    const termCalls = spy.mock.calls.filter((c) => c[0].term !== undefined);
    expect(termCalls.map((c) => c[0].term).sort()).toEqual(["q1", "q2", "q3"]);
  });

  it("soft-degrades when one strategy call fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ctgov, "searchClinicalTrials").mockImplementation(async (q) => {
      if (q.term === "bad") throw new Error("CT.gov 500");
      return [trial("NCT5")];
    });
    const out = await searchTrials(
      makeState({ searchStrategy: strategy(["good", "bad"]) }),
    );
    expect(out.candidates!.map((t) => t.nctId)).toEqual(["NCT5"]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns {error} when both channels totally fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ctgov, "searchClinicalTrials").mockRejectedValue(
      new Error("network down"),
    );
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    expect(out.error).toMatch(/CT\.gov/i);
  });

  it("returns {candidates: []} when both channels return empty (not an error)", async () => {
    vi.spyOn(ctgov, "searchClinicalTrials").mockResolvedValue([]);
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it("runs the repurposing channel with bounded concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(ctgov, "searchClinicalTrials").mockImplementation(async (q) => {
      if (!q.intervention) return [];
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    });
    const candidates = Array.from({ length: 25 }, (_, i) =>
      repurposing(`D${i}`, `drug${i}`),
    );
    await searchTrials(makeState({ repurposingCandidates: candidates }));
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/nodes/search-trials.test.ts
```

Expected: FAIL — current `searchTrials` returns `{candidates: []}` unconditionally.

### Step 3: Implement the node

Replace `apps/agent/src/nodes/search-trials.ts` entirely:

```ts
/**
 * # search-trials
 *
 * Dual-channel trial discovery from ClinicalTrials.gov. The graph runs
 * this node after both upstream feeders complete:
 *
 *   - search-strategy channel: one CT.gov call per
 *     `state.searchStrategy.queries[i]` (`query.term=<query>`).
 *   - repurposing channel: one CT.gov call per
 *     `state.repurposingCandidates[i].drug.name`
 *     (`query.intr=<drug.name>`), bounded concurrency = 10.
 *
 * Both channels carry the same `state.searchStrategy.filters`. Results
 * are unioned and deduped by `nctId`. Each candidate is annotated with
 * provenance:
 *
 *   - `discoveredVia: ('strategy'|'repurposing')[]` — at least one entry.
 *   - `repurposingDrugIds: string[]` — the `drug.id` of each repurposing
 *     candidate whose intervention search surfaced this trial. Empty for
 *     strategy-only hits.
 *
 * ## Concurrency
 *
 * Strategy channel: parallel via `Promise.allSettled` (max 4 calls).
 * Repurposing channel: bounded via `mapWithConcurrency(..., 10, ...)`.
 * Combined: max 14 in-flight CT.gov calls per patient run.
 *
 * ## Error model
 *
 *   - No `searchStrategy` → `{error}`.
 *   - Single CT.gov call fails → warn-log, drop that call's contribution.
 *   - Both channels' Promise.allSettled rejected entirely → `{error}`.
 *   - Either channel produces ≥1 hit → success; partial loss tolerated.
 *   - No repurposing candidates → repurposing channel returns `[]`
 *     cleanly; strategy channel still runs.
 */

import type {
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import { searchClinicalTrials } from "../tools/clinicaltrials.js";
import type { AgentStateType } from "../state.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { errorMessage } from "../util/error.js";

const REPURPOSING_CONCURRENCY = 10;

type StrategyHit = { candidate: TrialCandidate; channel: "strategy" };
type RepurposingHit = {
  candidate: TrialCandidate;
  channel: "repurposing";
  drugId: string;
};

export async function searchTrials(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const strategy = state.searchStrategy;
  if (!strategy) {
    return { error: "No search strategy available" };
  }

  const [strategyResult, repurposingResult] = await Promise.allSettled([
    runStrategyChannel(strategy),
    runRepurposingChannel(strategy, state.repurposingCandidates),
  ]);

  const strategyHits = unwrapOrWarn(strategyResult, "strategy");
  const repurposingHits = unwrapOrWarn(repurposingResult, "repurposing");

  if (
    strategyHits.length === 0 &&
    repurposingHits.length === 0 &&
    strategyResult.status === "rejected" &&
    repurposingResult.status === "rejected"
  ) {
    return { error: "Failed to query CT.gov: both channels errored" };
  }

  return { candidates: unionAndDedupe(strategyHits, repurposingHits) };
}

async function runStrategyChannel(
  strategy: SearchStrategy,
): Promise<StrategyHit[]> {
  const settled = await Promise.allSettled(
    strategy.queries.map((q) =>
      searchClinicalTrials({ term: q, filters: strategy.filters }),
    ),
  );
  const hits: StrategyHit[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      for (const c of r.value) hits.push({ candidate: c, channel: "strategy" });
    } else {
      console.warn(
        `search-trials: strategy query "${strategy.queries[i]}" failed: ${errorMessage(r.reason)}`,
      );
    }
  }
  return hits;
}

async function runRepurposingChannel(
  strategy: SearchStrategy,
  candidates: RepurposingCandidate[],
): Promise<RepurposingHit[]> {
  if (candidates.length === 0) return [];
  const results = await mapWithConcurrency(
    candidates,
    REPURPOSING_CONCURRENCY,
    async (rc): Promise<RepurposingHit[]> => {
      try {
        const trials = await searchClinicalTrials({
          intervention: rc.drug.name,
          filters: strategy.filters,
        });
        return trials.map((t) => ({
          candidate: t,
          channel: "repurposing" as const,
          drugId: rc.drug.id,
        }));
      } catch (err) {
        console.warn(
          `search-trials: repurposing query "${rc.drug.name}" failed: ${errorMessage(err)}`,
        );
        return [];
      }
    },
  );
  return results.flat();
}

function unwrapOrWarn<T>(
  result: PromiseSettledResult<T[]>,
  label: string,
): T[] {
  if (result.status === "fulfilled") return result.value;
  console.warn(`search-trials: ${label} channel rejected: ${errorMessage(result.reason)}`);
  return [];
}

function unionAndDedupe(
  strategyHits: StrategyHit[],
  repurposingHits: RepurposingHit[],
): TrialCandidate[] {
  const byNctId = new Map<string, TrialCandidate>();
  for (const { candidate } of strategyHits) {
    if (byNctId.has(candidate.nctId)) continue;
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

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/nodes/search-trials.test.ts
```

Expected: PASS, all 10 test cases.

### Step 5: Commit

```bash
git add apps/agent/src/nodes/search-trials.ts apps/agent/src/nodes/search-trials.test.ts
git commit -m "Implement search-trials: dual-channel CT.gov discovery + provenance"
```

---

## Task 7: `prompts/pre-filter.ts` — prompt + structured-output schema

**Files:**
- Modify: `apps/agent/src/prompts/pre-filter.ts`
- Create: `apps/agent/src/prompts/pre-filter.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/prompts/pre-filter.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ELIGIBILITY_EXCERPT_CHARS,
  PreFilterJudgmentSchema,
  preFilterPrompt,
} from "./pre-filter.js";
import type {
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

function profile(overrides: Partial<PatientProfile> = {}): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 60,
    sex: "female",
    deceased: false,
    conditions: [
      {
        code: "44054006",
        system: "http://snomed.info/sct",
        display: "Type 2 diabetes mellitus",
        clinicalStatus: "active",
      },
    ],
    medications: [
      {
        code: "1",
        system: "rxn",
        display: "metformin",
        events: [{ date: "2024-01-01", status: "active" }],
      },
    ],
    labs: [],
    priorTreatments: [
      { code: "x", system: "rxn", display: "doxorubicin", date: "2023-04-15" },
    ],
    ...overrides,
  };
}

function candidate(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Drug X"],
    status: "RECRUITING",
    locations: [],
    eligibilityCriteriaText:
      "Inclusion: age 18-75 with T2DM\nExclusion: prior insulin therapy",
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    ...overrides,
  };
}

describe("preFilterPrompt", () => {
  it("includes patient age and sex", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toContain("age 60");
    expect(out).toContain("sex female");
  });

  it("includes active conditions, medications, and prior treatments", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toContain("Type 2 diabetes mellitus");
    expect(out).toContain("metformin");
    expect(out).toContain("doxorubicin");
  });

  it("includes the trial's title, conditions, interventions, and eligibility excerpt", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toContain("Drug X for T2DM");
    expect(out).toContain("Type 2 Diabetes Mellitus");
    expect(out).toContain("Drug X");
    expect(out).toContain("prior insulin therapy");
  });

  it("truncates eligibility text to ELIGIBILITY_EXCERPT_CHARS", () => {
    const long = "x".repeat(ELIGIBILITY_EXCERPT_CHARS + 500);
    const out = preFilterPrompt(profile(), candidate({ eligibilityCriteriaText: long }));
    // The full long string must not appear verbatim; the truncated form
    // (first N chars) must.
    expect(out).not.toContain(long);
    expect(out).toContain("x".repeat(ELIGIBILITY_EXCERPT_CHARS));
  });

  it("handles missing eligibility text gracefully", () => {
    const out = preFilterPrompt(
      profile(),
      candidate({ eligibilityCriteriaText: undefined }),
    );
    expect(out).toContain("eligibility criteria");
    expect(out).toContain("(none)");
  });

  it("instructs the model to KEEP when in doubt", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toMatch(/when in doubt.*keep/i);
  });
});

describe("PreFilterJudgmentSchema", () => {
  it("accepts a valid drop", () => {
    const parsed = PreFilterJudgmentSchema.parse({
      keep: false,
      reason: "requires prior anti-PD-1 therapy patient hasn't had",
    });
    expect(parsed.keep).toBe(false);
  });

  it("accepts a keep with empty reason", () => {
    const parsed = PreFilterJudgmentSchema.parse({ keep: true, reason: "" });
    expect(parsed.keep).toBe(true);
  });

  it("rejects when keep is missing", () => {
    expect(() =>
      PreFilterJudgmentSchema.parse({ reason: "x" }),
    ).toThrow();
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/prompts/pre-filter.test.ts
```

Expected: FAIL — current `prompts/pre-filter.ts` exports only an empty stub.

### Step 3: Implement the prompt + schema

Replace `apps/agent/src/prompts/pre-filter.ts` entirely:

```ts
/**
 * # prompts/pre-filter
 *
 * Stage-2 prompt for `nodes/pre-filter.ts`. Produces a `keep / drop`
 * judgment per surviving candidate. Stage 1 (deterministic gates) is
 * handled in the node directly — this prompt only sees candidates that
 * already passed status, age, sex, and deceased checks.
 *
 * The instruction "when in doubt, KEEP" is load-bearing. False-positives
 * here (keeping a trial that turns out ineligible) are cheap — the
 * expensive `trial-eval` eligibility node runs per-criterion analysis
 * downstream and catches them. False-negatives (dropping a trial that
 * should have advanced) are expensive — they vanish from the run.
 *
 * Eligibility criteria from CT.gov can run several KB. We truncate to
 * `ELIGIBILITY_EXCERPT_CHARS` for the prompt; `trial-eval` reads the
 * full text from `state.candidates` so truncation only affects this
 * stage's coarse judgment.
 */

import { z } from "zod";

import {
  isActiveCondition,
  type PatientProfile,
  type TrialCandidate,
} from "@clinical-trial-matching/shared";

export const ELIGIBILITY_EXCERPT_CHARS = 2000;

export const PreFilterJudgmentSchema = z.object({
  keep: z.boolean(),
  reason: z.string(),
});
export type PreFilterJudgment = z.infer<typeof PreFilterJudgmentSchema>;

export function preFilterPrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
): string {
  const conditions = profile.conditions
    .filter(isActiveCondition)
    .map((c) => c.display)
    .join(", ");
  const meds = profile.medications
    .filter((m) => m.events.some((e) => e.status === "active" || e.status === "in-progress"))
    .map((m) => m.display)
    .join(", ");
  const priorTx = profile.priorTreatments.map((p) => p.display).join(", ");

  const elig = candidate.eligibilityCriteriaText
    ? candidate.eligibilityCriteriaText.slice(0, ELIGIBILITY_EXCERPT_CHARS)
    : "(none)";

  return `You're triaging a clinical trial against a patient profile. Drop the trial
ONLY if there's an obvious eligibility blocker visible in the brief
eligibility text. When in doubt, KEEP — a downstream expensive eligibility
checker will analyze in detail.

Patient:
  - age ${profile.ageYears}, sex ${profile.sex}
  - active conditions: ${conditions || "(none)"}
  - active medications: ${meds || "(none)"}
  - prior treatments: ${priorTx || "(none)"}

Trial:
  - title: ${candidate.title}
  - conditions: ${candidate.conditions.join(", ") || "(none)"}
  - interventions: ${candidate.interventions.join(", ") || "(none)"}
  - eligibility criteria (excerpt, first ${ELIGIBILITY_EXCERPT_CHARS} chars):
    ${elig}

Return keep=true unless one of these is clear from the text above:
  - patient lacks a required prior therapy
  - patient has an excluded condition or excluded prior therapy
  - patient is in an excluded subpopulation (e.g. pregnant, organ failure)

reason: short phrase explaining the call. Empty string if keep=true.`;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/prompts/pre-filter.test.ts
```

Expected: PASS, all 9 test cases.

### Step 5: Commit

```bash
git add apps/agent/src/prompts/pre-filter.ts apps/agent/src/prompts/pre-filter.test.ts
git commit -m "Implement pre-filter prompt + structured-output judgment schema"
```

---

## Task 8: `nodes/pre-filter.ts` — two-stage filter

**Files:**
- Modify: `apps/agent/src/nodes/pre-filter.ts`
- Create: `apps/agent/src/nodes/pre-filter.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/nodes/pre-filter.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { structuredInvoke, withStructuredOutput } = vi.hoisted(() => {
  const structuredInvoke = vi.fn();
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  return { structuredInvoke, withStructuredOutput };
});
vi.mock("../llm.js", () => ({
  llm: { withStructuredOutput },
}));

import { preFilter } from "./pre-filter.js";
import type { AgentStateType } from "../state.js";
import type {
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

beforeEach(() => {
  structuredInvoke.mockReset();
  withStructuredOutput.mockClear();
});

afterEach(() => vi.restoreAllMocks());

function profile(overrides: Partial<PatientProfile> = {}): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 60,
    sex: "female",
    deceased: false,
    conditions: [],
    medications: [],
    labs: [],
    priorTreatments: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT_DEFAULT",
    title: "Default",
    conditions: [],
    interventions: [],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    patientProfile: profile(),
    candidates: [],
    ...overrides,
  } as unknown as AgentStateType;
}

describe("preFilter", () => {
  it("returns {error} when patientProfile is null", async () => {
    const out = await preFilter(makeState({ patientProfile: null }));
    expect(out.error).toMatch(/patient profile/i);
  });

  it("returns empty kept + empty drops when candidates is empty", async () => {
    const out = await preFilter(makeState({ candidates: [] }));
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops).toEqual([]);
    expect(structuredInvoke).not.toHaveBeenCalled();
  });

  it("drops on non-enrolling status (stage1)", async () => {
    const out = await preFilter(
      makeState({
        candidates: [
          candidate({ nctId: "NCT_DONE", title: "Done", status: "COMPLETED" }),
        ],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops).toHaveLength(1);
    expect(out.candidateDrops![0]).toMatchObject({
      nctId: "NCT_DONE",
      reason: "not-recruiting",
      stage: "stage1",
      detail: "COMPLETED",
    });
  });

  it("drops on minimumAge above patient age (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ ageYears: 12 }),
        candidates: [candidate({ nctId: "NCT_ADULT", minimumAge: "18 Years" })],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops![0]).toMatchObject({
      nctId: "NCT_ADULT",
      reason: "age-too-young",
      stage: "stage1",
      detail: "18 Years",
    });
  });

  it("drops on maximumAge below patient age (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ ageYears: 80 }),
        candidates: [candidate({ nctId: "NCT_KID", maximumAge: "75 Years" })],
      }),
    );
    expect(out.candidateDrops![0]).toMatchObject({
      reason: "age-too-old",
      detail: "75 Years",
    });
  });

  it("drops on sex mismatch (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ sex: "female" }),
        candidates: [candidate({ nctId: "NCT_M", sexEligibility: "MALE" })],
      }),
    );
    expect(out.candidateDrops![0]).toMatchObject({
      reason: "sex-mismatch",
      detail: "MALE",
    });
  });

  it("does not drop on sex when patient sex is 'other' or 'unknown'", async () => {
    structuredInvoke.mockResolvedValue({ keep: true, reason: "" });
    const out = await preFilter(
      makeState({
        patientProfile: profile({ sex: "unknown" }),
        candidates: [candidate({ sexEligibility: "MALE" })],
      }),
    );
    expect(out.candidates).toHaveLength(1);
  });

  it("drops everything when patient is deceased (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ deceased: true }),
        candidates: [candidate({ nctId: "NCT_X" })],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops![0]).toMatchObject({
      reason: "deceased",
      stage: "stage1",
    });
  });

  it("invokes the LLM on stage1 survivors", async () => {
    structuredInvoke.mockResolvedValue({ keep: true, reason: "" });
    await preFilter(
      makeState({ candidates: [candidate({ nctId: "NCT_KEEP" })] }),
    );
    expect(structuredInvoke).toHaveBeenCalledTimes(1);
  });

  it("drops stage2 with reason 'llm-ineligible' and LLM detail", async () => {
    structuredInvoke.mockResolvedValue({
      keep: false,
      reason: "requires prior insulin therapy",
    });
    const out = await preFilter(
      makeState({ candidates: [candidate({ nctId: "NCT_INS" })] }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops![0]).toMatchObject({
      nctId: "NCT_INS",
      reason: "llm-ineligible",
      stage: "stage2",
      detail: "requires prior insulin therapy",
    });
  });

  it("keeps the candidate on LLM error (lenient) and does NOT record a drop", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    structuredInvoke.mockRejectedValue(new Error("rate limited"));
    const out = await preFilter(
      makeState({ candidates: [candidate({ nctId: "NCT_LENIENT" })] }),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.nctId).toBe("NCT_LENIENT");
    expect(out.candidateDrops).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("preserves stage1 drops alongside stage2 drops in candidateDrops", async () => {
    structuredInvoke.mockResolvedValueOnce({
      keep: false,
      reason: "no kidney function ≥30 GFR",
    });
    const out = await preFilter(
      makeState({
        candidates: [
          candidate({ nctId: "NCT_DONE", status: "COMPLETED" }),
          candidate({ nctId: "NCT_LLM" }),
        ],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops).toHaveLength(2);
    const stages = out.candidateDrops!.map((d) => d.stage).sort();
    expect(stages).toEqual(["stage1", "stage2"]);
  });

  it("runs stage2 with bounded concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    structuredInvoke.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { keep: true, reason: "" };
    });
    const candidates = Array.from({ length: 25 }, (_, i) =>
      candidate({ nctId: `NCT_${i}` }),
    );
    await preFilter(makeState({ candidates }));
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/nodes/pre-filter.test.ts
```

Expected: FAIL — current `preFilter` returns `{candidates: []}` unconditionally.

### Step 3: Implement the node

Replace `apps/agent/src/nodes/pre-filter.ts` entirely:

```ts
/**
 * # pre-filter
 *
 * Two-stage filter that cuts the candidate list from ~50–200 down to
 * ~10–30 before the expensive `trial-eval` fan-out.
 *
 * ## Stage 1 — deterministic gates
 *
 * Pure functions on `TrialCandidate` + `PatientProfile`. Drops the
 * candidate if any rule fires; each drop is recorded in
 * `state.candidateDrops` with `stage: "stage1"` and a `detail` matching
 * the gate that fired (raw status, parsed age string, etc.).
 *
 *   - status not enrolling-ish    → drop "not-recruiting"
 *   - patient age < minimumAge    → drop "age-too-young"
 *   - patient age > maximumAge    → drop "age-too-old"
 *   - sex mismatch                → drop "sex-mismatch"
 *   - patient deceased            → drop "deceased" (catches everything)
 *
 * Missing / unparseable structured fields skip the gate (lenient).
 *
 * ## Stage 2 — LLM-as-judge
 *
 * One Haiku call per Stage-1 survivor (bounded concurrency 10),
 * `withStructuredOutput(PreFilterJudgmentSchema)`. The prompt instructs
 * the model to KEEP when in doubt — false-negatives are expensive,
 * false-positives are cheap (trial-eval catches them downstream).
 *
 * LLM failure on a candidate → keep it (lenient); do NOT record a drop.
 * The audit log is for "we dropped X because Y" and a transient error
 * isn't that.
 *
 * ## Output
 *
 *   { candidates: kept, candidateDrops: drops }
 *
 * Both fields use replace-on-write reducers — a broaden-loop re-run
 * overwrites both with the new pass's results.
 */

import type {
  CandidateDrop,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import { llm } from "../llm.js";
import {
  PreFilterJudgmentSchema,
  preFilterPrompt,
} from "../prompts/pre-filter.js";
import type { AgentStateType } from "../state.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { errorMessage } from "../util/error.js";
import { isEnrollingStatus, parseAgeYears } from "../util/ctgov.js";

const STAGE2_CONCURRENCY = 10;

export async function preFilter(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const profile = state.patientProfile;
  if (!profile) {
    return { error: "No patient profile available" };
  }
  if (state.candidates.length === 0) {
    return { candidates: [], candidateDrops: [] };
  }

  const drops: CandidateDrop[] = [];
  const stage1Survivors: TrialCandidate[] = [];

  for (const c of state.candidates) {
    const drop = stage1Drop(c, profile);
    if (drop) drops.push(drop);
    else stage1Survivors.push(c);
  }

  console.info(
    `pre-filter stage 1: ${state.candidates.length} in, ${stage1Survivors.length} kept, ${drops.length} dropped`,
  );

  const stage2Results = await mapWithConcurrency(
    stage1Survivors,
    STAGE2_CONCURRENCY,
    (c) => judgeStage2(c, profile),
  );

  const kept: TrialCandidate[] = [];
  for (let i = 0; i < stage1Survivors.length; i++) {
    const c = stage1Survivors[i]!;
    const judgment = stage2Results[i];
    if (judgment && !judgment.keep) {
      drops.push({
        nctId: c.nctId,
        title: c.title,
        reason: "llm-ineligible",
        stage: "stage2",
        detail: judgment.reason,
      });
    } else {
      kept.push(c);
    }
  }

  return { candidates: kept, candidateDrops: drops };
}

function stage1Drop(
  c: TrialCandidate,
  profile: PatientProfile,
): CandidateDrop | null {
  if (profile.deceased) {
    return drop(c, "deceased", "stage1");
  }
  if (!isEnrollingStatus(c.status)) {
    return drop(c, "not-recruiting", "stage1", c.status);
  }
  const minAge = parseAgeYears(c.minimumAge);
  if (minAge !== undefined && profile.ageYears < minAge) {
    return drop(c, "age-too-young", "stage1", c.minimumAge);
  }
  const maxAge = parseAgeYears(c.maximumAge);
  if (maxAge !== undefined && profile.ageYears > maxAge) {
    return drop(c, "age-too-old", "stage1", c.maximumAge);
  }
  if (
    c.sexEligibility &&
    c.sexEligibility !== "ALL" &&
    (profile.sex === "male" || profile.sex === "female") &&
    c.sexEligibility !== profile.sex.toUpperCase()
  ) {
    return drop(c, "sex-mismatch", "stage1", c.sexEligibility);
  }
  return null;
}

function drop(
  c: TrialCandidate,
  reason: CandidateDrop["reason"],
  stage: CandidateDrop["stage"],
  detail?: string,
): CandidateDrop {
  return { nctId: c.nctId, title: c.title, reason, stage, detail };
}

// Returns the parsed judgment, or null on LLM error (lenient keep).
async function judgeStage2(
  c: TrialCandidate,
  profile: PatientProfile,
): Promise<{ keep: boolean; reason: string } | null> {
  try {
    const structured = llm.withStructuredOutput(PreFilterJudgmentSchema);
    return await structured.invoke(preFilterPrompt(profile, c));
  } catch (err) {
    console.warn(
      `pre-filter: stage 2 LLM failed for ${c.nctId}: ${errorMessage(err)} (keeping)`,
    );
    return null;
  }
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/nodes/pre-filter.test.ts
```

Expected: PASS, all 13 test cases.

### Step 5: Run the full agent test suite — sanity check nothing else broke

```bash
pnpm --filter agent test
```

Expected: PASS across all existing tests. The schema additions are additive and shouldn't break anything; the agent state guard already validated parity in Task 2.

### Step 6: Commit

```bash
git add apps/agent/src/nodes/pre-filter.ts apps/agent/src/nodes/pre-filter.test.ts
git commit -m "Implement pre-filter: deterministic gates + LLM-as-judge with audit"
```

---

## Task 9: Update `docs/topology.md`

**Files:**
- Modify: `docs/topology.md`

### Step 1: Update the state table

In `docs/topology.md`, find the state table (search for `| Field | Type | Reducer |`). Add a new row immediately after the `candidates` row:

```markdown
| `candidateDrops` | `CandidateDrop[]` | replace | pre-filter | UI (audit display) |
```

### Step 2: Update the `search-trials` section

Find the `### search-trials` section. Replace its "Writes:" line with:

```markdown
**Writes:** `candidates` (with `discoveredVia` and `repurposingDrugIds` provenance attached)
```

And add at the end of the section's prose paragraph:

```markdown
Each candidate carries provenance: `discoveredVia: ("strategy"|"repurposing")[]` and `repurposingDrugIds: string[]`. Strategy-only hits have `discoveredVia: ["strategy"]` and `repurposingDrugIds: []`. Repurposing channel hits carry the source `drug.id` values from `state.repurposingCandidates`; trials surfaced by both channels carry both labels. CT.gov calls retry on 429/503 with exponential backoff inside `tools/clinicaltrials.ts`; per-call failures are warn-logged and don't kill the channel.
```

### Step 3: Update the `pre-filter` section

Find the `### pre-filter` section. Replace its body with:

```markdown
**Reads:** `patientProfile`, `candidates`
**Writes:** `candidates` (survivors), `candidateDrops` (audit trail)
**Prompt:** `preFilterPrompt(profile, candidate)` (Stage 2 only)
**LLM call:** Yes — per Stage-1 survivor, bounded concurrency 10.

Two-stage filter that cuts the candidate list from ~50–200 down to ~10–30 before the expensive `trial-eval` fan-out.

Stage 1 — deterministic gates (no LLM): drops on non-enrolling status, age outside the trial's `minimumAge`/`maximumAge` window, sex mismatch, or patient deceased.

Stage 2 — LLM-as-judge (Haiku, structured output): per Stage-1 survivor, the model returns `{keep, reason}`. The prompt instructs the model to keep when in doubt — false-negatives here are expensive (the trial vanishes from the run), false-positives are cheap (the downstream `trial-eval` eligibility node will catch them).

Every drop — Stage 1 or Stage 2 — produces an entry in `state.candidateDrops` with `{nctId, title, reason, stage, detail}` for audit display. LLM call failures are treated as keep (lenient) and do not produce a drop entry.
```

### Step 4: Commit

```bash
git add docs/topology.md
git commit -m "Document search-trials provenance + two-stage pre-filter in topology"
```

---

## Final verification

After Task 9, run the full suite once more and verify the workspace builds clean:

```bash
pnpm -r typecheck
pnpm -r test
```

Both should pass. At this point:

- `tools/clinicaltrials.ts` is a real CT.gov v2 client with retry.
- `search-trials` performs dual-channel discovery, unions and dedupes with provenance.
- `pre-filter` runs both deterministic and LLM-based filtering, persisting an audit trail.
- The graph is end-to-end wired: a `pnpm dev` against a real patient produces actual CT.gov candidates flowing through `pre-filter` to the existing fan-out, which the drug-eval spec's `trial-eval` enrichment can then consume.
