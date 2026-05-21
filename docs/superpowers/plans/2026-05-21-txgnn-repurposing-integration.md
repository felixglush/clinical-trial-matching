# TxGNN-backed repurposing integration (data layer + discovery channel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the TxGNN data ingestion + lookup layer, rewrite `find-repurposing-candidates` to use it, and implement `search-trials` so trials are discovered via both the search-strategy channel and the repurposing channel (intervention drug names from TxGNN).

**Architecture:** Build-time script fetches and normalizes TxGNN's distributed prediction tables into two committed JSON artifacts (predictions keyed by MONDO id, explanations keyed by `mondoId::drugId`). Runtime `tools/txgnn.ts` is a pure in-memory lookup, mirroring `tools/snomed-mondo.ts`. `find-repurposing-candidates` consumes `state.mechanisms`, calls the lookup, dedupes by drug id, and emits `RepurposingCandidate[]`. `search-trials` queries `clinicaltrials.gov` once for the search strategy and once per repurposing candidate (intervention name), unions and dedupes by `nctId`. This plan stops at populating `state.candidates`; trial-eval enrichments and the `rank-and-synthesize` appendix get separate plans.

**Tech Stack:** TypeScript (strict, `bundler` module resolution), Node 24, pnpm workspaces, Zod, LangGraph.js, vitest, tsx (for build scripts), neo4j-driver (used by adjacent code; this plan does not touch Neo4j directly), ClinicalTrials.gov API v2 (`https://clinicaltrials.gov/api/v2/studies`).

**Spec:** `docs/superpowers/specs/2026-05-21-drug-eval-subgraph-design.md` (v2). This plan implements the spec's "Scope" first three bullets and leaves the trial-eval enrichments and rank-and-synthesize appendix for follow-on plans (which will need to implement those node's baselines first).

**Conventions referenced:** `docs/codebase-conventions.md` (file layout, naming, test style), `CLAUDE.md` (pin exact dependency versions — `pnpm add -E`).

---

## File map

- **Create:**
  - `docs/txgnn-distribution.md` — research output from Task 0 (dump source, schema, license, refresh procedure).
  - `apps/agent/src/tools/txgnn.ts` — runtime lookup (pure in-memory dict).
  - `apps/agent/src/tools/txgnn.test.ts` — vitest tests against fixtures.
  - `apps/agent/src/tools/__fixtures__/txgnn-predictions-fixture.json` — small hand-crafted fixture for tests.
  - `apps/agent/src/tools/__fixtures__/txgnn-explanations-fixture.json` — same.
  - `apps/agent/src/tools/clinicaltrials.test.ts` — vitest tests.
  - `apps/agent/src/nodes/find-repurposing-candidates.test.ts` — vitest tests.
  - `apps/agent/src/nodes/search-trials.test.ts` — vitest tests.
  - `scripts/build-txgnn-data.ts` — build script.
  - `scripts/build-txgnn-data.test.ts` — unit test for the script's transform function (fixture in, expected JSON out).
- **Modify:**
  - `packages/shared/src/repurposing.ts` — extend `RepurposingCandidateSchema` with optional `predIndication`, `predContraindication`.
  - `apps/agent/src/tools/clinicaltrials.ts` — replace `throw new Error(...)` with a real CT.gov API v2 implementation.
  - `apps/agent/src/nodes/find-repurposing-candidates.ts` — replace stub with TxGNN-backed implementation.
  - `apps/agent/src/nodes/search-trials.ts` — replace stub with two-query union+dedup.
  - `package.json` (repo root) — add `kg:build-txgnn` script.
- **Generated (committed if size ≤ ~10 MB; decision in Task 7):**
  - `apps/agent/src/data/txgnn-predictions.json`
  - `apps/agent/src/data/txgnn-explanations.json`

---

## Task 0: Verify TxGNN distribution format

**Why this task exists:** Spec Risk #1 — TxGNN's distributed prediction format is publicly known to exist (github.com/mims-harvard/TxGNN, txgnn.org) but the exact schema (file format, column names, whether explainer paths ship alongside scores, license, download URL stability) has not been verified. Writing the build script without this is guessing.

**Files:**
- Create: `docs/txgnn-distribution.md`

- [ ] **Step 1: Dispatch an Explore agent**

Use the Agent tool, `subagent_type: "Explore"`, prompt:

```
Investigate how TxGNN's pre-computed predictions are publicly distributed. The
goal is to ingest them into a Node.js build script — I need to know exactly
what to download and parse.

Specifically report:

1. Where the prediction tables are downloadable. Check at least:
   - https://github.com/mims-harvard/TxGNN (repo README + releases)
   - https://txgnn.org
   - Harvard Dataverse (search for "TxGNN" or "Huang Zitnik drug repurposing")

2. For each download source found:
   - URL (direct, stable if possible)
   - File format (CSV/TSV/parquet/JSON/other)
   - Column names and types — for both indication and contraindication
     predictions
   - Whether explainer paths (multi-hop disease↔drug paths) ship as part of
     the same file, a sibling file, or have to be regenerated
   - Approximate file size on disk

3. The license under which the predictions are distributed (MIT? CC-BY? Other?).

4. How the predictions map disease and drug ids:
   - Are diseases identified by MONDO ids (e.g. "MONDO:0005148") or PrimeKG
     internal node ids?
   - Are drugs identified by DrugBank ids (e.g. "DB00331"), PrimeKG internal
     node ids, or something else?
   - Are drug names included in the same row, or do we need a separate lookup?

5. The TxGNN paper and code base both reference PrimeKG. Confirm whether the
   predictions use the same node-id space as PrimeKG.

Return a concise report (under 500 words) with the above. If anything is
ambiguous, say so explicitly rather than guessing.
```

- [ ] **Step 2: Write `docs/txgnn-distribution.md`**

Capture the agent's findings in this exact structure (substitute the agent's reported values for the bracketed placeholders — do not commit the placeholders):

```markdown
# TxGNN distribution format

Research date: 2026-05-21. **Re-verify before re-running the build if more than a few months have passed** — repo layouts and Dataverse paths change.

## Source
- URL: [download URL]
- License: [license]
- Approximate size: [size]

## File format
- Predictions: [format + brief schema]
  - Disease id column: `[name]` — values are [MONDO ids / PrimeKG internal ids]
  - Drug id column: `[name]` — values are [DrugBank / PrimeKG / other]
  - Drug name column: `[name or "not present — needs PrimeKG nodes.csv join"]`
  - Indication probability column: `[name]`
  - Contraindication probability column: `[name]`
- Explanations: [where they ship — same file / separate file / regenerable only]

## Notes / open issues
- [Anything the Explore agent flagged as ambiguous]
```

If the Explore agent reports that explanations are *only* regeneratable (not distributed), capture that — Task 7 will need to handle that case by emitting an empty explanations file and relying on a later metapath-Cypher fallback (which lives in a future plan, not this one).

- [ ] **Step 3: Commit**

```bash
git add docs/txgnn-distribution.md
git commit -m "Document TxGNN distribution format for ingestion build script"
```

---

## Task 1: Shared-schema extensions

Two extensions in one task because they're tightly coupled to the rest of the plan:

- `Mechanism` gains `mondoId` — `find-repurposing-candidates` needs to key TxGNN lookups by MONDO id, but `Mechanism.conditionId` currently holds the *SNOMED* code (`apps/agent/src/tools/kg.ts:184`). Exposing the MONDO id directly is cleaner than re-running the SNOMED→MONDO crosswalk in the downstream node. The data is already in scope in `kg.ts` (`disease.mondoId` from `ResolvedDisease`).
- `RepurposingCandidate` gains optional `predIndication` / `predContraindication`.

**Files:**
- Modify: `packages/shared/src/mechanism.ts`
- Modify: `packages/shared/src/repurposing.ts`
- Modify: `apps/agent/src/tools/kg.ts`

- [ ] **Step 1: Add `mondoId` to `MechanismSchema`**

In `packages/shared/src/mechanism.ts`, change the `MechanismSchema` block:

```ts
export const MechanismSchema = z.object({
  conditionId: z.string(),
  conditionName: z.string(),
  geneTargets: z.array(KGNodeSchema),
  pathways: z.array(KGNodeSchema),
  supportingPaths: z.array(KGPathSchema),
  rationale: z.string(),
});
```

to:

```ts
export const MechanismSchema = z.object({
  conditionId: z.string(),         // SNOMED code (matches PatientProfile.conditions[].code)
  conditionName: z.string(),
  mondoId: z.string(),             // resolved MONDO id, e.g. "MONDO:0005148"; used by TxGNN lookups downstream
  geneTargets: z.array(KGNodeSchema),
  pathways: z.array(KGNodeSchema),
  supportingPaths: z.array(KGPathSchema),
  rationale: z.string(),
});
```

- [ ] **Step 2: Populate `mondoId` in `kg.ts`**

In `apps/agent/src/tools/kg.ts`, find the `CandidateMechanism` literal around line 183:

```ts
const mechanism: CandidateMechanism = {
  conditionId: cond.snomedCode,
  conditionName: cond.conditionDisplay,
  geneTargets,
  pathways,
  supportingPaths,
};
```

Change to:

```ts
const mechanism: CandidateMechanism = {
  conditionId: cond.snomedCode,
  conditionName: cond.conditionDisplay,
  mondoId: disease.mondoId,
  geneTargets,
  pathways,
  supportingPaths,
};
```

Also locate the `CandidateMechanism` type definition near the top of `kg.ts` and add `mondoId: string` to it. (Search for `type CandidateMechanism = ` or `export type CandidateMechanism`.) If `CandidateMechanism` is defined as `Omit<Mechanism, "rationale">` or similar, it picks the new field up automatically; verify by typechecking in Step 4.

- [ ] **Step 3: Extend `RepurposingCandidateSchema`**

In `packages/shared/src/repurposing.ts`, change:

```ts
export const RepurposingCandidateSchema = z.object({
  drug: KGNodeSchema,
  originalIndications: z.array(z.string()),
  rationale: z.string(),
  supportingPaths: z.array(KGPathSchema),
});
```

to:

```ts
export const RepurposingCandidateSchema = z.object({
  drug: KGNodeSchema,
  originalIndications: z.array(z.string()),
  rationale: z.string(),
  supportingPaths: z.array(KGPathSchema),
  // Populated when the candidate came from a TxGNN lookup. Optional because
  // a future non-TxGNN producer (manual entry, alternate model) wouldn't have
  // these. Range: [0, 1].
  predIndication: z.number().min(0).max(1).optional(),
  predContraindication: z.number().min(0).max(1).optional(),
});
```

Leave `RepurposingRationaleSchema` (lines 12–17) untouched.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If `_AgentStateMatchesGraphState` in `apps/agent/src/state.ts` complains, the schema-vs-state guard is doing its job — but the changes here should not break it (`MechanismSchema` change flows through `AgentState.mechanisms`; the optional `RepurposingCandidate` fields don't affect required-field matching).

- [ ] **Step 5: Run agent tests**

Existing `identify-relevant-mechanisms` tests likely assert on `Mechanism` shape. They should still pass — adding a required field is a breaking change at the schema level *only* if existing test fixtures construct Mechanism objects literally. Run:

Run: `pnpm --filter agent test`
Expected: PASS, or a small handful of test-fixture updates needed where mechanisms are constructed inline. If failures appear in `identify-relevant-mechanisms.test.ts` or `kg.test.ts`, add `mondoId: "MONDO:..."` to the relevant fixtures. Use the real MONDO ids from `snomed-to-primekg.json` to keep tests honest.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/mechanism.ts packages/shared/src/repurposing.ts apps/agent/src/tools/kg.ts apps/agent/src/tools/kg.test.ts apps/agent/src/nodes/identify-relevant-mechanisms.test.ts
git commit -m "Add mondoId to Mechanism; extend RepurposingCandidate with TxGNN scores"
```

(Only stage test files in the commit if you actually had to modify them in Step 5.)

---

## Task 2: Implement `tools/txgnn.ts` + fixtures + tests

This is the runtime lookup. It loads two JSON files via the `with { type: "json" }` import assertion (same pattern as `snomed-mondo.ts`). For tests, we use small hand-crafted fixtures so the runtime is testable before the real build script runs.

**Files:**
- Create: `apps/agent/src/tools/__fixtures__/txgnn-predictions-fixture.json`
- Create: `apps/agent/src/tools/__fixtures__/txgnn-explanations-fixture.json`
- Create: `apps/agent/src/tools/txgnn.ts`
- Create: `apps/agent/src/tools/txgnn.test.ts`

- [ ] **Step 1: Write the predictions fixture**

`apps/agent/src/tools/__fixtures__/txgnn-predictions-fixture.json`:

```json
{
  "MONDO:0005148": [
    { "drugId": "DB00331", "drugName": "metformin",     "predIndication": 0.94, "predContraindication": 0.08 },
    { "drugId": "DB01067", "drugName": "glipizide",     "predIndication": 0.89, "predContraindication": 0.11 },
    { "drugId": "DB06292", "drugName": "dapagliflozin", "predIndication": 0.86, "predContraindication": 0.09 }
  ],
  "MONDO:0007254": [
    { "drugId": "DB01006", "drugName": "letrozole",     "predIndication": 0.92, "predContraindication": 0.12 },
    { "drugId": "DB00675", "drugName": "tamoxifen",     "predIndication": 0.91, "predContraindication": 0.10 }
  ]
}
```

- [ ] **Step 2: Write the explanations fixture**

`apps/agent/src/tools/__fixtures__/txgnn-explanations-fixture.json`:

```json
{
  "MONDO:0005148::DB06292": {
    "nodes": [
      { "id": "DB06292", "name": "dapagliflozin", "type": "drug" },
      { "id": "SLC5A2",  "name": "SLC5A2",        "type": "gene_protein" },
      { "id": "GO:0035623", "name": "glucose reabsorption", "type": "biological_process" },
      { "id": "MONDO:0005148", "name": "type 2 diabetes mellitus", "type": "disease" }
    ],
    "edges": [
      { "source": "DB06292", "target": "SLC5A2", "relation": "target" },
      { "source": "SLC5A2", "target": "GO:0035623", "relation": "interacts with" },
      { "source": "GO:0035623", "target": "MONDO:0005148", "relation": "associated with" }
    ]
  }
}
```

Note `relation`, not `label` — matches `KGEdgeSchema` in `packages/shared/src/mechanism.ts:11`.

- [ ] **Step 3: Write the test file (failing)**

`apps/agent/src/tools/txgnn.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  __setFixturesForTests,
  isCovered,
  lookupExplanation,
  lookupPredictions,
} from "./txgnn.js";

import predictionsFixture from "./__fixtures__/txgnn-predictions-fixture.json" with { type: "json" };
import explanationsFixture from "./__fixtures__/txgnn-explanations-fixture.json" with { type: "json" };

// The runtime normally loads JSON committed under apps/agent/src/data/.
// Tests inject fixture data via __setFixturesForTests so we don't depend on
// the data layer being built.
__setFixturesForTests(predictionsFixture, explanationsFixture);

describe("lookupPredictions", () => {
  it("returns top-N predictions for a covered MONDO id, sorted by predIndication desc", () => {
    const out = lookupPredictions("MONDO:0005148", 2);
    expect(out.map((p) => p.drugId)).toEqual(["DB00331", "DB01067"]);
    expect(out[0].predIndication).toBe(0.94);
  });

  it("clamps topN to the available predictions", () => {
    const out = lookupPredictions("MONDO:0005148", 99);
    expect(out).toHaveLength(3);
  });

  it("returns empty array for uncovered MONDO id", () => {
    expect(lookupPredictions("MONDO:9999999", 5)).toEqual([]);
  });
});

describe("lookupExplanation", () => {
  it("returns the KGPath for a covered (disease, drug) pair", () => {
    const path = lookupExplanation("MONDO:0005148", "DB06292");
    expect(path).not.toBeNull();
    expect(path!.nodes).toHaveLength(4);
    expect(path!.edges[0].relation).toBe("target");
  });

  it("returns null when no explanation is distributed for the pair", () => {
    expect(lookupExplanation("MONDO:0005148", "DB00331")).toBeNull();
  });
});

describe("isCovered", () => {
  it("returns true for a MONDO id present in predictions", () => {
    expect(isCovered("MONDO:0005148")).toBe(true);
  });

  it("returns false for an uncovered MONDO id", () => {
    expect(isCovered("MONDO:9999999")).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test to confirm it fails**

Run: `pnpm --filter agent test src/tools/txgnn.test.ts`
Expected: FAIL with "Cannot find module './txgnn.js'" (the file does not exist yet).

- [ ] **Step 5: Write the implementation**

`apps/agent/src/tools/txgnn.ts`:

```ts
// Pure in-memory lookup over the committed TxGNN prediction dump. The dump
// is built by `pnpm kg:build-txgnn` (see scripts/build-txgnn-data.ts) and
// lives at apps/agent/src/data/txgnn-{predictions,explanations}.json.
//
// Why a static dump rather than live inference: TxGNN is a GNN that needs a
// GPU to score. The Zitnik lab distributes pre-computed predictions for the
// ~17k diseases × ~8k drugs PrimeKG covers; we ship those as JSON so the
// agent boots offline on LangGraph Platform.
//
// Schema (mirrors the JSONs):
//   predictions: { [mondoId]: TxGNNPrediction[] }   sorted by predIndication desc
//   explanations: { [`${mondoId}::${drugId}`]: KGPath }
//
// Error behavior — per spec error model: missing/malformed data files are a
// build-time bug and should be loud. We surface the failure at first use
// (not at module load — that would crash the agent at boot in dev), and the
// calling node (`find-repurposing-candidates`) catches and returns
// `{error}`.
//
// Tests inject fixtures via __setFixturesForTests so they don't depend on
// the production data files existing.

import type { KGPath } from "@clinical-trial-matching/shared";

export type TxGNNPrediction = {
  drugId: string;
  drugName: string;
  predIndication: number;
  predContraindication: number;
};

type PredictionsMap = Record<string, TxGNNPrediction[]>;
type ExplanationsMap = Record<string, KGPath>;

type LoadState =
  | { kind: "unloaded" }
  | { kind: "ready"; predictions: PredictionsMap; explanations: ExplanationsMap }
  | { kind: "error"; message: string };

let state: LoadState = { kind: "unloaded" };

async function ensureLoaded(): Promise<void> {
  if (state.kind !== "unloaded") return;
  try {
    const predMod = await import("../data/txgnn-predictions.json", {
      with: { type: "json" },
    });
    const explMod = await import("../data/txgnn-explanations.json", {
      with: { type: "json" },
    });
    state = {
      kind: "ready",
      predictions: (predMod.default ?? predMod) as PredictionsMap,
      explanations: (explMod.default ?? explMod) as ExplanationsMap,
    };
  } catch (err) {
    state = {
      kind: "error",
      message: `TxGNN data files missing or malformed (run \`pnpm kg:build-txgnn\`): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readyOrThrow(): {
  predictions: PredictionsMap;
  explanations: ExplanationsMap;
} {
  if (state.kind === "ready") return state;
  if (state.kind === "error") throw new Error(state.message);
  throw new Error("tools/txgnn: ensureLoaded() must be awaited before first lookup.");
}

// Test-only injection point. Production code does not call this; tests do.
// Bypasses the import-based loader entirely.
export function __setFixturesForTests(
  preds: PredictionsMap,
  expls: ExplanationsMap,
): void {
  state = { kind: "ready", predictions: preds, explanations: expls };
}

// Called by the node before any sync lookup. Idempotent.
export async function ensureTxgnnLoaded(): Promise<void> {
  await ensureLoaded();
  // Throw early so the caller can convert to a node-level {error}.
  readyOrThrow();
}

export function lookupPredictions(
  mondoId: string,
  topN: number,
): TxGNNPrediction[] {
  const { predictions } = readyOrThrow();
  const all = predictions[mondoId];
  if (!all) return [];
  return all.slice(0, topN);
}

export function lookupExplanation(
  mondoId: string,
  drugId: string,
): KGPath | null {
  const { explanations } = readyOrThrow();
  return explanations[`${mondoId}::${drugId}`] ?? null;
}

export function isCovered(mondoId: string): boolean {
  const { predictions } = readyOrThrow();
  return predictions[mondoId] !== undefined && predictions[mondoId].length > 0;
}
```

Three design points worth noting:

- The data files are loaded via dynamic `import(...)` with the JSON assertion. Top-level static imports would crash the module at startup before the build script has been run (a real pain in dev). Lazy load lets us surface the failure at the first node invocation, where it can become `{error: "..."}`.
- The `__setFixturesForTests` export is the standard project-internal seam. It bypasses the loader by jumping straight to `{kind: "ready"}`. The underscore prefix marks it as private API.
- `ensureTxgnnLoaded()` is what `find-repurposing-candidates` calls before its loop. After it returns, the synchronous `lookup*` calls are safe. If it throws, the node catches and returns `{error}`.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `pnpm --filter agent test src/tools/txgnn.test.ts`
Expected: PASS, 7 tests (3 + 2 + 2).

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/tools/txgnn.ts apps/agent/src/tools/txgnn.test.ts apps/agent/src/tools/__fixtures__/
git commit -m "Add tools/txgnn.ts: in-memory lookup for TxGNN predictions"
```

---

## Task 3: Implement `clinicaltrials.ts` (CT.gov API v2)

**Files:**
- Modify: `apps/agent/src/tools/clinicaltrials.ts`
- Create: `apps/agent/src/tools/clinicaltrials.test.ts`

Background on the API: ClinicalTrials.gov API v2 lives at `https://clinicaltrials.gov/api/v2/studies`. It accepts query params including `query.cond` (condition), `query.intr` (intervention), `filter.overallStatus` (e.g. `RECRUITING|NOT_YET_RECRUITING`), `pageSize`, and `format=json`. Each returned study has a nested `protocolSection` with `identificationModule.nctId`, `identificationModule.briefTitle`, `descriptionModule.briefSummary`, `conditionsModule.conditions`, `armsInterventionsModule.interventions[].name`, `designModule.phases`, `statusModule.overallStatus`, `eligibilityModule.eligibilityCriteria`, and `contactsLocationsModule.locations`.

This task implements **a single named search function** (the existing `searchClinicalTrials` signature accepting `SearchStrategy`). Task 5 (`search-trials.ts`) will issue two queries: one from the strategy, one per repurposing candidate. So this file also needs a sibling helper that takes raw query params; that helper is what both callers use.

- [ ] **Step 1: Confirm the existing types we need**

Read `packages/shared/src/trial.ts:6-26` to confirm `TrialLocation` and `TrialCandidate` shapes. Read `packages/shared/src/searchStrategy.ts` (or wherever `SearchStrategy` lives) to know its fields.

Run: `grep -rn "SearchStrategySchema\|SearchStrategy " /Users/felixg/dev/clinical-trial-matching/packages/shared/src/ | head`

You should find `SearchStrategySchema` and confirm field names (`conditions`, `interventions`, `mechanisms`, or similar). Use whatever fields actually exist — *do not invent field names*.

- [ ] **Step 2: Write the failing test**

`apps/agent/src/tools/clinicaltrials.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchClinicalTrialsRaw } from "./clinicaltrials.js";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetchJson(body: unknown) {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const SAMPLE_STUDY = {
  protocolSection: {
    identificationModule: {
      nctId: "NCT05000001",
      briefTitle: "A Phase 2 Trial of Dapagliflozin in T2DM with CKD",
    },
    descriptionModule: {
      briefSummary: "Investigating dapagliflozin in adults with type 2 diabetes and stage-3 chronic kidney disease.",
    },
    conditionsModule: { conditions: ["Type 2 Diabetes Mellitus", "Chronic Kidney Disease"] },
    armsInterventionsModule: {
      interventions: [{ name: "Dapagliflozin" }, { name: "Placebo" }],
    },
    designModule: { phases: ["PHASE2"] },
    statusModule: { overallStatus: "RECRUITING" },
    eligibilityModule: { eligibilityCriteria: "Adults ≥ 18; eGFR 30–60; ..." },
    contactsLocationsModule: {
      locations: [
        { facility: "Mass General", city: "Boston", state: "MA", country: "United States", status: "RECRUITING" },
      ],
    },
  },
};

describe("searchClinicalTrialsRaw", () => {
  it("constructs the v2 URL with query.cond and query.intr params", async () => {
    mockFetchJson({ studies: [] });
    await searchClinicalTrialsRaw({ condition: "Type 2 Diabetes", intervention: "metformin" });
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("clinicaltrials.gov/api/v2/studies");
    expect(url).toContain("query.cond=Type+2+Diabetes");
    expect(url).toContain("query.intr=metformin");
    expect(url).toContain("format=json");
  });

  it("maps a study record into a TrialCandidate with phase + status normalized", async () => {
    mockFetchJson({ studies: [SAMPLE_STUDY] });
    const out = await searchClinicalTrialsRaw({ condition: "T2DM" });
    expect(out).toHaveLength(1);
    expect(out[0].nctId).toBe("NCT05000001");
    expect(out[0].title).toContain("Dapagliflozin");
    expect(out[0].conditions).toEqual(["Type 2 Diabetes Mellitus", "Chronic Kidney Disease"]);
    expect(out[0].interventions).toEqual(["Dapagliflozin", "Placebo"]);
    expect(out[0].phase).toBe("PHASE2");
    expect(out[0].status).toBe("RECRUITING");
    expect(out[0].locations[0].facility).toBe("Mass General");
  });

  it("returns empty array when CT.gov returns no studies", async () => {
    mockFetchJson({ studies: [] });
    const out = await searchClinicalTrialsRaw({ condition: "X" });
    expect(out).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    global.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      searchClinicalTrialsRaw({ condition: "X" }),
    ).rejects.toThrow(/CT\.gov/);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm --filter agent test src/tools/clinicaltrials.test.ts`
Expected: FAIL — `searchClinicalTrialsRaw` is not exported.

- [ ] **Step 4: Write the implementation**

`apps/agent/src/tools/clinicaltrials.ts`:

```ts
// CT.gov API v2 thin wrapper. Two entry points:
//   - searchClinicalTrials(strategy)    — used by search-trials.ts for the
//                                          search-strategy channel
//   - searchClinicalTrialsRaw(params)   — used by search-trials.ts for the
//                                          per-repurposing-candidate channel
// Both return TrialCandidate[]; callers union and dedupe by nctId.
//
// We default to active-recruiting trials (RECRUITING + NOT_YET_RECRUITING)
// because the agent's job is finding *enrollable* trials. Completed and
// withdrawn studies are noise for this task.

import type {
  SearchStrategy,
  TrialCandidate,
  TrialLocation,
} from "@clinical-trial-matching/shared";

const BASE_URL = "https://clinicaltrials.gov/api/v2/studies";
const DEFAULT_PAGE_SIZE = 50;
const ACTIVE_STATUSES = ["RECRUITING", "NOT_YET_RECRUITING"];

export type RawQueryParams = {
  condition?: string;
  intervention?: string;
  pageSize?: number;
  activeOnly?: boolean; // default true
};

export async function searchClinicalTrialsRaw(
  params: RawQueryParams,
): Promise<TrialCandidate[]> {
  const url = buildUrl(params);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `CT.gov request failed: ${res.status} ${res.statusText} (url=${url})`,
    );
  }
  const body = (await res.json()) as { studies?: unknown[] };
  const studies = body.studies ?? [];
  return studies.map(parseStudy).filter((c): c is TrialCandidate => c !== null);
}

export async function searchClinicalTrials(
  strategy: SearchStrategy,
): Promise<TrialCandidate[]> {
  // SearchStrategy has condition + mechanism term lists; we join them into
  // one cond query and (if present) the strategy's intervention hint into
  // one intr query.
  //
  // Field names below MUST match the actual SearchStrategySchema. If you're
  // reading this after editing the schema, update here too.
  const cond = strategy.conditions?.join(" OR ") ?? "";
  const intr = strategy.interventions?.join(" OR ");
  return searchClinicalTrialsRaw({
    condition: cond || undefined,
    intervention: intr || undefined,
  });
}

function buildUrl(params: RawQueryParams): string {
  const u = new URL(BASE_URL);
  if (params.condition) u.searchParams.set("query.cond", params.condition);
  if (params.intervention) u.searchParams.set("query.intr", params.intervention);
  if (params.activeOnly !== false) {
    u.searchParams.set("filter.overallStatus", ACTIVE_STATUSES.join("|"));
  }
  u.searchParams.set("pageSize", String(params.pageSize ?? DEFAULT_PAGE_SIZE));
  u.searchParams.set("format", "json");
  return u.toString();
}

function parseStudy(study: unknown): TrialCandidate | null {
  const ps = (study as { protocolSection?: Record<string, unknown> })
    .protocolSection;
  if (!ps) return null;
  const ident = ps.identificationModule as
    | { nctId?: string; briefTitle?: string }
    | undefined;
  const desc = ps.descriptionModule as { briefSummary?: string } | undefined;
  const cond = ps.conditionsModule as { conditions?: string[] } | undefined;
  const arms = ps.armsInterventionsModule as
    | { interventions?: { name?: string }[] }
    | undefined;
  const design = ps.designModule as { phases?: string[] } | undefined;
  const status = ps.statusModule as { overallStatus?: string } | undefined;
  const elig = ps.eligibilityModule as { eligibilityCriteria?: string } | undefined;
  const locs = ps.contactsLocationsModule as
    | { locations?: TrialLocation[] }
    | undefined;

  if (!ident?.nctId || !ident?.briefTitle || !status?.overallStatus) {
    return null;
  }

  return {
    nctId: ident.nctId,
    title: ident.briefTitle,
    briefSummary: desc?.briefSummary,
    conditions: cond?.conditions ?? [],
    interventions: (arms?.interventions ?? []).flatMap((i) =>
      i.name ? [i.name] : [],
    ),
    phase: design?.phases?.[0],
    status: status.overallStatus,
    eligibilityCriteriaText: elig?.eligibilityCriteria,
    locations: locs?.locations ?? [],
  };
}
```

**Field-name caveat:** the `strategy.conditions` and `strategy.interventions` accesses in `searchClinicalTrials` are inferred from the spec's wording. If `SearchStrategySchema` uses different field names, fix them here. The test suite for *this* file does not depend on those names (it uses the raw helper) so it'll pass either way.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter agent test src/tools/clinicaltrials.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run all agent tests to make sure nothing else broke**

Run: `pnpm --filter agent test`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/tools/clinicaltrials.ts apps/agent/src/tools/clinicaltrials.test.ts
git commit -m "Implement clinicaltrials.ts: CT.gov API v2 wrapper"
```

---

## Task 4: Rewrite `find-repurposing-candidates.ts`

The node consumes `state.mechanisms` and uses each mechanism's `mondoId` (added in Task 1) to call `lookupPredictions`. Deduplicates across mechanisms by drug id; logs uncovered MONDOs; returns `{repurposingCandidates: ...}` or `{error: ...}` if the TxGNN data isn't loadable.

**Files:**
- Modify: `apps/agent/src/nodes/find-repurposing-candidates.ts`
- Create: `apps/agent/src/nodes/find-repurposing-candidates.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/agent/src/nodes/find-repurposing-candidates.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findRepurposingCandidates } from "./find-repurposing-candidates.js";
import { __setFixturesForTests } from "../tools/txgnn.js";
import type { AgentStateType } from "../state.js";
import type { Mechanism } from "@clinical-trial-matching/shared";

import predictionsFixture from "../tools/__fixtures__/txgnn-predictions-fixture.json" with { type: "json" };
import explanationsFixture from "../tools/__fixtures__/txgnn-explanations-fixture.json" with { type: "json" };

beforeEach(() => {
  __setFixturesForTests(predictionsFixture, explanationsFixture);
});

function mech(input: {
  snomed: string;
  mondoId: string;
  name: string;
}): Mechanism {
  return {
    conditionId: input.snomed,
    conditionName: input.name,
    mondoId: input.mondoId,
    geneTargets: [],
    pathways: [],
    supportingPaths: [],
    rationale: "",
  };
}

function stateWithMechanisms(mechanisms: Mechanism[]): AgentStateType {
  return {
    mechanisms,
  } as unknown as AgentStateType;
}

describe("findRepurposingCandidates", () => {
  it("emits top-N TxGNN drugs per mechanism", async () => {
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const candidates = out.repurposingCandidates ?? [];
    expect(candidates.map((c) => c.drug.id).sort()).toEqual([
      "DB00331",
      "DB01067",
      "DB06292",
    ]);
    const metformin = candidates.find((c) => c.drug.id === "DB00331");
    expect(metformin!.predIndication).toBe(0.94);
    expect(metformin!.rationale).toContain("TxGNN");
  });

  it("dedupes across mechanisms by drug.id, keeping the highest predIndication", async () => {
    __setFixturesForTests(
      {
        ...predictionsFixture,
        "MONDO:0005300": [
          { drugId: "DB00331", drugName: "metformin", predIndication: 0.75, predContraindication: 0.20 },
        ],
      } as Record<string, unknown> as never,
      explanationsFixture,
    );
    const state = stateWithMechanisms([
      mech({ snomed: "44054006",  mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
      mech({ snomed: "709044004", mondoId: "MONDO:0005300", name: "chronic kidney disease" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const metformin = out.repurposingCandidates?.filter(
      (c) => c.drug.id === "DB00331",
    );
    expect(metformin).toHaveLength(1);
    expect(metformin![0].predIndication).toBe(0.94);
    expect(metformin![0].originalIndications.sort()).toEqual([
      "chronic kidney disease",
      "type 2 diabetes mellitus",
    ]);
  });

  it("attaches the explanation path when one is distributed", async () => {
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const dapa = out.repurposingCandidates?.find((c) => c.drug.id === "DB06292");
    expect(dapa!.supportingPaths).toHaveLength(1);
    expect(dapa!.supportingPaths[0].nodes).toHaveLength(4);
  });

  it("leaves supportingPaths empty when no explanation is distributed", async () => {
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const metformin = out.repurposingCandidates?.find((c) => c.drug.id === "DB00331");
    expect(metformin!.supportingPaths).toEqual([]);
  });

  it("returns empty list when state.mechanisms is empty", async () => {
    const state = stateWithMechanisms([]);
    const out = await findRepurposingCandidates(state);
    expect(out.repurposingCandidates).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it("logs and continues when a mechanism's MONDO id is uncovered", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = stateWithMechanisms([
      mech({ snomed: "999999", mondoId: "MONDO:9999999", name: "made-up disease" }),
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    expect(out.repurposingCandidates).toHaveLength(3); // only T2DM produced
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MONDO:9999999"),
    );
    warnSpy.mockRestore();
  });

  it("returns {error} when TxGNN data is unloadable", async () => {
    // Reset the module-level state to an error condition. We simulate by
    // pointing __setFixturesForTests at a fresh fixture, then directly
    // poking the module via a re-import would be brittle; instead, the
    // production code path is exercised by the integration smoke test in
    // Task 7. This unit test asserts the node SHAPE — that an error from
    // ensureTxgnnLoaded surfaces as {error: ...}. We do that by mocking
    // ensureTxgnnLoaded itself.
    const txgnn = await import("../tools/txgnn.js");
    const spy = vi
      .spyOn(txgnn, "ensureTxgnnLoaded")
      .mockRejectedValue(new Error("TxGNN data files missing"));
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    expect(out.error).toMatch(/TxGNN data files missing/);
    expect(out.repurposingCandidates).toBeUndefined();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter agent test src/nodes/find-repurposing-candidates.test.ts`
Expected: FAIL (the current stub returns `{repurposingCandidates: []}` unconditionally).

- [ ] **Step 3: Write the implementation**

`apps/agent/src/nodes/find-repurposing-candidates.ts`:

```ts
/**
 * # find-repurposing-candidates
 *
 * For each kept mechanism (a patient disease + MONDO id), look up the top-N
 * TxGNN-predicted drugs and emit them as `RepurposingCandidate[]`. The list
 * is deduped across mechanisms by drug id: a drug that appears for multiple
 * patient diseases surfaces once, keeping the highest predIndication and
 * unioning the source diseases into `originalIndications`.
 *
 * The output feeds two downstream consumers:
 *   1. `search-trials` issues a CT.gov query per candidate (intervention
 *      name), unioning with the search-strategy channel for full trial
 *      discovery coverage.
 *   2. (Future plan) `trial-eval`'s `mechanism-plausibility` consumes
 *      `supportingPaths` (TxGNN's explainer path) when a matched trial came
 *      from the repurposing channel.
 *
 * Coverage: a MONDO id absent from the TxGNN dump produces no candidates
 * and a `console.warn`. The graph continues — the search-strategy channel
 * still runs.
 *
 * Error model: if the TxGNN data files are unloadable, we surface that as
 * a node-level `{error}`. Per spec, missing data is a build-time bug; the
 * agent should fail loud rather than silently produce empty repurposing
 * candidates.
 */

import type {
  KGPath,
  Mechanism,
  RepurposingCandidate,
} from "@clinical-trial-matching/shared";

import {
  ensureTxgnnLoaded,
  isCovered,
  lookupExplanation,
  lookupPredictions,
  type TxGNNPrediction,
} from "../tools/txgnn.js";
import type { AgentStateType } from "../state.js";
import { errorMessage } from "../util/error.js";

const TOP_N_PER_MECHANISM = 10;

export async function findRepurposingCandidates(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const mechanisms = state.mechanisms;
  if (!mechanisms || mechanisms.length === 0) {
    return { repurposingCandidates: [] };
  }

  try {
    await ensureTxgnnLoaded();
  } catch (err) {
    return { error: `find-repurposing-candidates: ${errorMessage(err)}` };
  }

  // Per-drug aggregation. Key: drug id. Value: best candidate so far +
  // the set of source disease names.
  type Acc = {
    candidate: RepurposingCandidate;
    sourceDiseases: Set<string>;
  };
  const byDrug = new Map<string, Acc>();
  const uncovered: string[] = [];

  for (const mech of mechanisms) {
    if (!isCovered(mech.mondoId)) {
      uncovered.push(mech.mondoId);
      continue;
    }
    const preds = lookupPredictions(mech.mondoId, TOP_N_PER_MECHANISM);
    for (const pred of preds) {
      const path = lookupExplanation(mech.mondoId, pred.drugId);
      const existing = byDrug.get(pred.drugId);
      if (existing) {
        existing.sourceDiseases.add(mech.conditionName);
        // Keep the higher-scoring prediction as the canonical row.
        if (pred.predIndication > (existing.candidate.predIndication ?? 0)) {
          existing.candidate = buildCandidate(pred, mech, path);
        }
      } else {
        byDrug.set(pred.drugId, {
          candidate: buildCandidate(pred, mech, path),
          sourceDiseases: new Set([mech.conditionName]),
        });
      }
    }
  }

  if (uncovered.length > 0) {
    console.warn(
      `find-repurposing-candidates: ${uncovered.length} MONDO id(s) uncovered by TxGNN: ${uncovered.join(", ")}`,
    );
  }

  const out: RepurposingCandidate[] = [...byDrug.values()].map(
    ({ candidate, sourceDiseases }) => ({
      ...candidate,
      originalIndications: [...sourceDiseases].sort(),
    }),
  );

  return { repurposingCandidates: out };
}

function buildCandidate(
  pred: TxGNNPrediction,
  mech: Mechanism,
  path: KGPath | null,
): RepurposingCandidate {
  return {
    drug: { id: pred.drugId, name: pred.drugName, type: "drug" },
    originalIndications: [mech.conditionName],
    rationale: `TxGNN predicted for ${mech.conditionName} (indication ${pred.predIndication.toFixed(2)}).`,
    supportingPaths: path ? [path] : [],
    predIndication: pred.predIndication,
    predContraindication: pred.predContraindication,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter agent test src/nodes/find-repurposing-candidates.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/nodes/find-repurposing-candidates.ts apps/agent/src/nodes/find-repurposing-candidates.test.ts
git commit -m "Rewrite find-repurposing-candidates with TxGNN lookup"
```

---

## Task 5: Implement `search-trials.ts`

**Files:**
- Modify: `apps/agent/src/nodes/search-trials.ts`
- Create: `apps/agent/src/nodes/search-trials.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/agent/src/nodes/search-trials.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchTrials } from "./search-trials.js";
import * as ct from "../tools/clinicaltrials.js";
import type { AgentStateType, } from "../state.js";
import type { TrialCandidate } from "@clinical-trial-matching/shared";

afterEach(() => vi.restoreAllMocks());

function tc(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT00000001",
    title: "x",
    conditions: [],
    interventions: [],
    status: "RECRUITING",
    locations: [],
    ...overrides,
  };
}

function stateWith({
  strategy,
  candidates,
}: {
  strategy?: AgentStateType["searchStrategy"];
  candidates?: AgentStateType["repurposingCandidates"];
} = {}): AgentStateType {
  return {
    searchStrategy: strategy ?? null,
    repurposingCandidates: candidates ?? [],
  } as unknown as AgentStateType;
}

describe("searchTrials", () => {
  it("issues a search-strategy query when strategy is present", async () => {
    const spy = vi.spyOn(ct, "searchClinicalTrials").mockResolvedValue([tc()]);
    const rawSpy = vi.spyOn(ct, "searchClinicalTrialsRaw").mockResolvedValue([]);
    const out = await searchTrials(
      stateWith({ strategy: { conditions: ["T2DM"], interventions: [] } as never }),
    );
    expect(spy).toHaveBeenCalledOnce();
    expect(out.candidates).toHaveLength(1);
    expect(rawSpy).not.toHaveBeenCalled();
  });

  it("issues one per-candidate intervention query when no strategy is present", async () => {
    const stratSpy = vi
      .spyOn(ct, "searchClinicalTrials")
      .mockResolvedValue([]);
    const rawSpy = vi
      .spyOn(ct, "searchClinicalTrialsRaw")
      .mockImplementation(async ({ intervention }) => [
        tc({ nctId: `NCT-${intervention}`, interventions: [intervention!] }),
      ]);
    const out = await searchTrials(
      stateWith({
        candidates: [
          {
            drug: { id: "DB00331", name: "metformin", type: "drug" },
            originalIndications: ["T2DM"],
            rationale: "",
            supportingPaths: [],
          },
          {
            drug: { id: "DB01067", name: "glipizide", type: "drug" },
            originalIndications: ["T2DM"],
            rationale: "",
            supportingPaths: [],
          },
        ],
      }),
    );
    expect(stratSpy).not.toHaveBeenCalled();
    expect(rawSpy).toHaveBeenCalledTimes(2);
    expect(out.candidates?.map((c) => c.nctId).sort()).toEqual([
      "NCT-glipizide",
      "NCT-metformin",
    ]);
  });

  it("unions strategy + per-candidate results, deduping by nctId", async () => {
    vi.spyOn(ct, "searchClinicalTrials").mockResolvedValue([
      tc({ nctId: "NCT-shared", interventions: ["metformin"] }),
    ]);
    vi.spyOn(ct, "searchClinicalTrialsRaw").mockResolvedValue([
      tc({ nctId: "NCT-shared", interventions: ["metformin"] }),
      tc({ nctId: "NCT-only-drug", interventions: ["metformin"] }),
    ]);
    const out = await searchTrials(
      stateWith({
        strategy: { conditions: ["T2DM"], interventions: [] } as never,
        candidates: [
          {
            drug: { id: "DB00331", name: "metformin", type: "drug" },
            originalIndications: ["T2DM"],
            rationale: "",
            supportingPaths: [],
          },
        ],
      }),
    );
    expect(out.candidates?.map((c) => c.nctId).sort()).toEqual([
      "NCT-only-drug",
      "NCT-shared",
    ]);
  });

  it("returns empty list when nothing is queryable", async () => {
    const out = await searchTrials(stateWith());
    expect(out.candidates).toEqual([]);
  });

  it("propagates a CT.gov error as state.error", async () => {
    vi.spyOn(ct, "searchClinicalTrials").mockRejectedValue(new Error("boom"));
    const out = await searchTrials(
      stateWith({ strategy: { conditions: ["X"], interventions: [] } as never }),
    );
    expect(out.error).toMatch(/Failed to search trials.*boom/);
    expect(out.candidates).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter agent test src/nodes/search-trials.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`apps/agent/src/nodes/search-trials.ts`:

```ts
/**
 * # search-trials
 *
 * Two-channel CT.gov discovery, unioned by nctId.
 *
 *   Channel A — search-strategy channel
 *     Driven by `state.searchStrategy`. Conditions + mechanism-derived
 *     keywords go to CT.gov as cond/intr query terms.
 *
 *   Channel B — repurposing channel
 *     One CT.gov query per RepurposingCandidate, using the drug name as
 *     `intervention`. Surfaces trials a pure keyword search would miss.
 *
 * Both channels feed into the same downstream pre-filter and trial-eval
 * pipeline. Provenance (which channel found a given trial) is left for the
 * follow-on trial-eval enrichment plan to populate on TrialMatch.
 *
 * Errors: CT.gov is the only external boundary. Either channel failing
 * aborts the node with state.error rather than returning a partial result —
 * a partial trial list would silently bias rank-and-synthesize.
 */

import type { AgentStateType } from "../state.js";
import type { TrialCandidate } from "@clinical-trial-matching/shared";

import {
  searchClinicalTrials,
  searchClinicalTrialsRaw,
} from "../tools/clinicaltrials.js";
import { errorMessage } from "../util/error.js";

export async function searchTrials(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const strategy = state.searchStrategy;
  const candidates = state.repurposingCandidates ?? [];

  if (!strategy && candidates.length === 0) {
    return { candidates: [] };
  }

  try {
    const queries: Promise<TrialCandidate[]>[] = [];
    if (strategy) {
      queries.push(searchClinicalTrials(strategy));
    }
    for (const c of candidates) {
      queries.push(
        searchClinicalTrialsRaw({ intervention: c.drug.name }),
      );
    }
    const results = await Promise.all(queries);

    const byNct = new Map<string, TrialCandidate>();
    for (const batch of results) {
      for (const t of batch) {
        // Dedup on nctId; first occurrence wins (strategy results come first).
        if (!byNct.has(t.nctId)) byNct.set(t.nctId, t);
      }
    }

    return { candidates: [...byNct.values()] };
  } catch (err) {
    return { error: `Failed to search trials: ${errorMessage(err)}` };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter agent test src/nodes/search-trials.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run all agent tests**

Run: `pnpm --filter agent test`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/nodes/search-trials.ts apps/agent/src/nodes/search-trials.test.ts
git commit -m "Implement search-trials: union search-strategy + repurposing channels"
```

---

## Task 6: Wire up the build script command

**Files:**
- Modify: `package.json` (repo root)
- Create: `scripts/build-txgnn-data.ts` (skeleton — implementation in Task 7)

We add the pnpm command first as a separate step so the next task can be done in a clean commit. The skeleton script just logs "not yet implemented" so the command exists and is discoverable.

- [ ] **Step 1: Add the script entry**

In `/Users/felixg/dev/clinical-trial-matching/package.json`, find the `scripts` section:

```jsonc
"scripts": {
  ...
  "kg:build-crosswalk": "tsx scripts/build-mondo-crosswalk.ts",
  "test:scripts": "vitest run scripts/"
}
```

Add `kg:build-txgnn` right after `kg:build-crosswalk`:

```jsonc
"scripts": {
  ...
  "kg:build-crosswalk": "tsx scripts/build-mondo-crosswalk.ts",
  "kg:build-txgnn": "tsx scripts/build-txgnn-data.ts",
  "test:scripts": "vitest run scripts/"
}
```

- [ ] **Step 2: Create the skeleton script**

`scripts/build-txgnn-data.ts`:

```ts
#!/usr/bin/env tsx
/* eslint-disable no-console */
//
// Build TxGNN prediction + explanation JSONs from the publicly distributed
// dump. See docs/txgnn-distribution.md for source URL, schema, and license
// captured at research time.
//
// Outputs:
//   apps/agent/src/data/txgnn-predictions.json
//   apps/agent/src/data/txgnn-explanations.json
//
// Filtering (defaults; tune later):
//   - drop rows where predIndication ≤ 0.5
//   - drop rows where predContraindication ≥ predIndication
//   - cap top-50 per disease (sorted by predIndication desc)
//   - normalize gene/protein → gene_protein in explanation paths
//
// Coverage scoping: by default we emit predictions for every disease in
// the TxGNN dump. To shrink to just the patient-archetype set, filter to
// MONDO ids present in apps/agent/src/data/snomed-to-primekg.json (TODO
// when output JSON size becomes an issue).

console.error("scripts/build-txgnn-data.ts: not yet implemented. See docs/txgnn-distribution.md.");
process.exit(1);
```

- [ ] **Step 3: Confirm the command is reachable**

Run: `pnpm kg:build-txgnn`
Expected: exits with code 1 and the "not yet implemented" message.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/build-txgnn-data.ts
git commit -m "Add kg:build-txgnn pnpm script skeleton"
```

---

## Task 7: Implement the build script

**Why this is its own task:** the script's input parsing depends on Task 0's findings. Doing it last lets every other task land independently of the dump format and means the runtime is fully tested and committed *before* you wrestle with the raw dump's shape.

**Files:**
- Modify: `scripts/build-txgnn-data.ts`
- Create: `scripts/build-txgnn-data.test.ts`
- Create (output of running the script): `apps/agent/src/data/txgnn-predictions.json`, `apps/agent/src/data/txgnn-explanations.json`

- [ ] **Step 1: Re-read Task 0's findings**

Read `docs/txgnn-distribution.md` and note the values for: source URL, file format, column names for (disease id, drug id, drug name, indication probability, contraindication probability), and whether explanations ship alongside scores or are a separate file.

- [ ] **Step 2: Write the failing test for the transform**

The test exercises the pure transform (raw rows → output JSONs) with fixtures, not the network download or filesystem write. Substitute the column names from Task 0 into the fixture inputs.

`scripts/build-txgnn-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { filterAndShape } from "./build-txgnn-data.js";

describe("filterAndShape", () => {
  it("filters by predIndication > 0.5", () => {
    const raw = [
      { disease: "MONDO:1", drugId: "DB1", drugName: "alpha",  pi: 0.91, pc: 0.10 },
      { disease: "MONDO:1", drugId: "DB2", drugName: "beta",   pi: 0.30, pc: 0.05 }, // dropped
    ];
    const out = filterAndShape(raw, { topKPerDisease: 50 });
    expect(out.predictions["MONDO:1"]).toHaveLength(1);
    expect(out.predictions["MONDO:1"][0].drugId).toBe("DB1");
  });

  it("filters by predContraindication >= predIndication", () => {
    const raw = [
      { disease: "MONDO:1", drugId: "DB3", drugName: "gamma", pi: 0.55, pc: 0.80 }, // dropped
      { disease: "MONDO:1", drugId: "DB4", drugName: "delta", pi: 0.55, pc: 0.30 }, // kept
    ];
    const out = filterAndShape(raw, { topKPerDisease: 50 });
    expect(out.predictions["MONDO:1"].map((p) => p.drugId)).toEqual(["DB4"]);
  });

  it("sorts and caps top-K per disease", () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({
      disease: "MONDO:1",
      drugId: `DB${i}`,
      drugName: `d${i}`,
      pi: 0.51 + i / 1000,
      pc: 0.10,
    }));
    const out = filterAndShape(raw, { topKPerDisease: 50 });
    expect(out.predictions["MONDO:1"]).toHaveLength(50);
    // Sorted desc — highest pi first
    expect(out.predictions["MONDO:1"][0].drugId).toBe("DB59");
  });

  it("preserves explanations only for kept (disease, drug) pairs", () => {
    const raw = [
      { disease: "MONDO:1", drugId: "DB1", drugName: "alpha", pi: 0.91, pc: 0.10 },
      { disease: "MONDO:1", drugId: "DB2", drugName: "beta",  pi: 0.30, pc: 0.05 },
    ];
    const rawExpl: Record<string, unknown> = {
      "MONDO:1::DB1": {
        nodes: [{ id: "DB1", name: "alpha", type: "drug" }],
        edges: [],
      },
      "MONDO:1::DB2": {
        nodes: [{ id: "DB2", name: "beta", type: "drug" }],
        edges: [],
      },
    };
    const out = filterAndShape(raw, { topKPerDisease: 50, rawExplanations: rawExpl });
    expect(Object.keys(out.explanations)).toEqual(["MONDO:1::DB1"]);
  });

  it("normalizes 'gene/protein' to 'gene_protein' in explanation node types", () => {
    const raw = [{ disease: "MONDO:1", drugId: "DB1", drugName: "alpha", pi: 0.91, pc: 0.10 }];
    const rawExpl = {
      "MONDO:1::DB1": {
        nodes: [
          { id: "X", name: "X", type: "gene/protein" },
        ],
        edges: [],
      },
    };
    const out = filterAndShape(raw, { topKPerDisease: 50, rawExplanations: rawExpl });
    expect(out.explanations["MONDO:1::DB1"].nodes[0].type).toBe("gene_protein");
  });
});
```

The shape of `raw` rows in the test is the *normalized* shape (after parsing the dump). The dump's actual column names get mapped to this shape in the parser step, which is small and pretty.

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm test:scripts -- build-txgnn-data.test.ts`
Expected: FAIL — `filterAndShape` is not exported.

- [ ] **Step 4: Implement the script**

`scripts/build-txgnn-data.ts` (replace the skeleton from Task 6):

```ts
#!/usr/bin/env tsx
/* eslint-disable no-console */
//
// Build TxGNN prediction + explanation JSONs from the publicly distributed
// dump.
//
// Source / schema: see docs/txgnn-distribution.md. Re-read it before
// running this script if the upstream layout may have changed.
//
// Outputs:
//   apps/agent/src/data/txgnn-predictions.json
//   apps/agent/src/data/txgnn-explanations.json
//
// Defaults (tunable via flags later if needed):
//   predIndication > 0.5
//   predContraindication < predIndication
//   top-50 per disease, sorted by predIndication desc
//   gene/protein → gene_protein normalization in explanation paths

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "apps/agent/src/data");
const OUT_PREDS = path.join(OUT_DIR, "txgnn-predictions.json");
const OUT_EXPLS = path.join(OUT_DIR, "txgnn-explanations.json");

// Raw row after parsing the dump but before filter/shape. Schema is a small
// adapter over whatever the dump's actual columns are — keep this stable.
export type RawRow = {
  disease: string;     // normalized MONDO id, e.g. "MONDO:0005148"
  drugId: string;      // normalized drug id (DrugBank or PrimeKG node id)
  drugName: string;
  pi: number;          // predIndication
  pc: number;          // predContraindication
};

export type RawExplanation = {
  nodes: { id: string; name: string; type: string }[];
  edges: { source: string; target: string; relation: string }[];
};

export type ShapedPrediction = {
  drugId: string;
  drugName: string;
  predIndication: number;
  predContraindication: number;
};

export type FilterAndShapeOptions = {
  topKPerDisease: number;
  rawExplanations?: Record<string, RawExplanation>;
};

export function filterAndShape(
  raw: RawRow[],
  opts: FilterAndShapeOptions,
): {
  predictions: Record<string, ShapedPrediction[]>;
  explanations: Record<string, RawExplanation>;
} {
  const kept: RawRow[] = [];
  for (const r of raw) {
    if (r.pi <= 0.5) continue;
    if (r.pc >= r.pi) continue;
    kept.push(r);
  }

  // Group by disease, sort desc by pi, cap top-K.
  const byDisease = new Map<string, RawRow[]>();
  for (const r of kept) {
    const bucket = byDisease.get(r.disease) ?? [];
    bucket.push(r);
    byDisease.set(r.disease, bucket);
  }
  const predictions: Record<string, ShapedPrediction[]> = {};
  for (const [disease, rows] of byDisease) {
    rows.sort((a, b) => b.pi - a.pi);
    predictions[disease] = rows.slice(0, opts.topKPerDisease).map((r) => ({
      drugId: r.drugId,
      drugName: r.drugName,
      predIndication: r.pi,
      predContraindication: r.pc,
    }));
  }

  // Keep only explanations whose (disease, drug) pair survived the filter.
  const keptPairs = new Set<string>();
  for (const [disease, preds] of Object.entries(predictions)) {
    for (const p of preds) keptPairs.add(`${disease}::${p.drugId}`);
  }
  const explanations: Record<string, RawExplanation> = {};
  for (const [key, expl] of Object.entries(opts.rawExplanations ?? {})) {
    if (!keptPairs.has(key)) continue;
    explanations[key] = {
      nodes: expl.nodes.map((n) => ({
        ...n,
        type: n.type === "gene/protein" ? "gene_protein" : n.type,
      })),
      edges: expl.edges,
    };
  }

  return { predictions, explanations };
}

// ─── Dump parsing ────────────────────────────────────────────────────────
//
// The two functions below are the only ones that need updating when the
// dump's column names change. The shape they emit (RawRow / RawExplanation)
// is the contract with filterAndShape, which is stable.

async function parsePredictionsDump(dumpPath: string): Promise<RawRow[]> {
  // EXAMPLE PARSER — replace with the actual format from docs/txgnn-
  // distribution.md. Pseudocode for a TSV with columns:
  //   <disease_col> <drug_id_col> <drug_name_col> <pred_indication_col> <pred_contraindication_col>
  const out: RawRow[] = [];
  if (!existsSync(dumpPath)) {
    throw new Error(`TxGNN dump not found at ${dumpPath}. Download per docs/txgnn-distribution.md.`);
  }
  const rl = createInterface({ input: createReadStream(dumpPath) });
  let header: string[] | null = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      continue;
    }
    // Replace these indices with the column positions from your dump.
    const disease = normalizeMondo(cols[0]);
    const drugId = cols[1];
    const drugName = cols[2];
    const pi = Number(cols[3]);
    const pc = Number(cols[4]);
    if (!disease || !drugId || Number.isNaN(pi) || Number.isNaN(pc)) continue;
    out.push({ disease, drugId, drugName, pi, pc });
  }
  return out;
}

async function parseExplanationsDump(
  dumpPath: string,
): Promise<Record<string, RawExplanation>> {
  // EXAMPLE PARSER — replace per docs/txgnn-distribution.md. If
  // explanations are not distributed (Task 0 confirmed), this returns {}
  // and the runtime gracefully degrades (`lookupExplanation` returns null).
  if (!existsSync(dumpPath)) return {};
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(dumpPath, "utf8")) as Record<string, RawExplanation>;
  return raw;
}

function normalizeMondo(s: string): string {
  // Some dumps emit "MONDO_0005148" with underscore; canonicalize to colon.
  return s.startsWith("MONDO_") ? `MONDO:${s.slice("MONDO_".length)}` : s;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Resolve dump paths from docs/txgnn-distribution.md. Hard-coded here for
  // now; switch to a flag if you need multiple versions.
  const PREDS_DUMP = path.join(REPO_ROOT, "data/kg/raw/txgnn-predictions.tsv");
  const EXPLS_DUMP = path.join(REPO_ROOT, "data/kg/raw/txgnn-explanations.json");

  console.log("Parsing predictions...");
  const raw = await parsePredictionsDump(PREDS_DUMP);
  console.log(`  ${raw.length} rows parsed`);

  console.log("Parsing explanations...");
  const rawExpls = await parseExplanationsDump(EXPLS_DUMP);
  console.log(`  ${Object.keys(rawExpls).length} pairs parsed`);

  console.log("Filtering + shaping...");
  const { predictions, explanations } = filterAndShape(raw, {
    topKPerDisease: 50,
    rawExplanations: rawExpls,
  });
  console.log(
    `  ${Object.keys(predictions).length} diseases kept; ${Object.values(predictions).reduce((a, b) => a + b.length, 0)} predictions; ${Object.keys(explanations).length} explanations`,
  );

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PREDS, JSON.stringify(predictions));
  await writeFile(OUT_EXPLS, JSON.stringify(explanations));
  console.log(`Wrote ${OUT_PREDS}`);
  console.log(`Wrote ${OUT_EXPLS}`);
}

// Only run main when this file is executed directly, not when imported by a
// test. Standard ESM idiom: compare the URL to process.argv[1].
if (import.meta.url.endsWith(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

**Important:** the two `parsePredictionsDump` / `parseExplanationsDump` functions contain example parsing. Before running this against real data, update them with the actual column positions / JSON keys from `docs/txgnn-distribution.md`. The test (`filterAndShape`) does **not** exercise these parsers, so the test suite will pass even with wrong column indices. That's fine for now; correctness of the parsers is verified by running the script against real data and eyeballing the output size and a couple of known (disease, drug) pairs (e.g. `MONDO:0005148` / dapagliflozin).

- [ ] **Step 5: Run the transform tests**

Run: `pnpm test:scripts -- build-txgnn-data.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Download the dump and run the build**

This is a one-off step the implementing engineer performs locally:

1. Per `docs/txgnn-distribution.md`, download the predictions file to `data/kg/raw/txgnn-predictions.tsv` (or whatever filename the doc records).
2. If explanations are distributed separately, download them to `data/kg/raw/txgnn-explanations.json` (or whatever).
3. Update the parser functions if the column names / positions differ from the example.
4. Run: `pnpm kg:build-txgnn`
5. Verify the output sizes are reasonable. Acceptable threshold for committing: **each output file < 10 MB**. If larger, see the "If outputs are too large to commit" note below.

- [ ] **Step 7: Smoke-test the runtime against the real data**

Run: `pnpm --filter agent test src/tools/txgnn.test.ts`
The fixture-based tests still pass. Add a tiny additional smoke test in `txgnn.test.ts` that, **without** calling `__setFixturesForTests`, checks `isCovered("MONDO:0005148")` returns true (since T2DM is in the archetype patients' SNOMED list and certainly in the TxGNN training set). If it returns false, the data files weren't generated correctly.

Optional smoke test snippet to append:

```ts
describe("production data file", () => {
  it("covers MONDO:0005148 (T2DM, in patient archetypes)", async () => {
    // Re-import to drop fixture injection.
    const mod = await import("./txgnn.js?fresh=" + Date.now());
    // (If the fresh-import trick doesn't play with vitest, skip this
    // assertion and rely on the build-time output sizes.)
    expect(mod.isCovered("MONDO:0005148")).toBe(true);
  });
});
```

If the fresh-import doesn't work cleanly under vitest, drop this and rely on visual verification: `head -c 1000 apps/agent/src/data/txgnn-predictions.json | jq 'has("MONDO:0005148")'` should print `true`.

- [ ] **Step 8: Commit the generated data files (if size permits)**

```bash
git add scripts/build-txgnn-data.ts scripts/build-txgnn-data.test.ts apps/agent/src/data/txgnn-predictions.json apps/agent/src/data/txgnn-explanations.json
git commit -m "Build TxGNN prediction/explanation JSONs and ingestion script"
```

**If outputs are too large to commit:**
- Do not add them to git. Add the two filenames to `.gitignore`.
- Add a `prebuild` or CI step that runs `pnpm kg:build-txgnn` (with the dump available via a release-artifact download). For local dev, document the manual download + build in `docs/txgnn-distribution.md`.
- Commit just `scripts/build-txgnn-data.ts`, `scripts/build-txgnn-data.test.ts`, and the `.gitignore` change.

---

## Final validation

- [ ] **Run the full test suite**

Run: `pnpm -r test`
Expected: ALL PASS.

- [ ] **Run typecheck across the workspace**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Sanity-check the new commands**

Run: `pnpm kg:build-txgnn --help 2>&1 | head` (the script ignores the flag, but the command exists)
Expected: the script runs (or exits with the dump-not-found error from `parsePredictionsDump` if the dump isn't downloaded — that's acceptable; the command is wired).

- [ ] **Confirm the spec's "in scope" boxes are checked**

Re-read `docs/superpowers/specs/2026-05-21-drug-eval-subgraph-design.md` "Scope" section. The following bullets must be done after this plan:

- ✅ Full rewrite of `find-repurposing-candidates.ts` using TxGNN predictions
- ✅ `search-trials` implementation: consumes both `state.searchStrategy` and `state.repurposingCandidates`, unions+dedupes by `nctId`

These three remain for follow-on plans (and require baseline implementations of the corresponding stubs):

- ⏭️ `trial-eval-subgraph` enrichment (populate `TrialMatch.repurposingRationale`, pass `supportingPaths` into `mechanism-plausibility`)
- ⏭️ New eligibility sub-check (intervention contraindication Cypher in `eligibility-check`)
- ⏭️ `rank-and-synthesize` no-trial-leads appendix
