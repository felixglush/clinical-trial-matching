# Mechanism Counter-Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PubMed sentiment-keyword OR-query that feeds `mechanism-plausibility`'s counter-evidence block with three structured biomedical signals (PrimeKG contraindication edges, TxGNN `predContraindication`, CT.gov terminated/withdrawn/suspended prior trials of the drug+condition with raw `whyStopped` passed unfiltered).

**Architecture:** A new `gather-counter-evidence` node runs in parallel with `literature-support` in the trial-eval subgraph. It writes a single `structuredCounterEvidence` object (three sub-fields, one per source) into state. `literature-support` loses its second PubMed call. `mechanism-plausibility`'s prompt renders the new block, drops the forced `supports: "no"` instruction. `synthesize-match`'s PMID-echo filter and "counter-evidence not addressed" concern are rewired to the new shape.

**Tech Stack:** TypeScript, LangGraph.js, Zod, Vitest, Neo4j (PrimeKG via `tools/kg.ts`), CT.gov v2 REST (`tools/clinicaltrials.ts`).

**Spec:** [`docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md`](../specs/2026-05-24-mechanism-counter-evidence-design.md).

---

## File map

**New files:**
- `apps/agent/src/subgraphs/trial-eval/util/repurposing.ts` — extracted `pickSource` helper (consumed by both `mechanism-plausibility` and `gather-counter-evidence`)
- `apps/agent/src/subgraphs/trial-eval/util/repurposing.test.ts` — unit test for `pickSource`
- `apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.ts` — the new parallel node
- `apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.test.ts` — node tests

**Modified files:**
- `packages/shared/src/trial.ts` — add `PriorTerminatedTrialSchema` + `StructuredCounterEvidenceSchema`
- `apps/agent/src/tools/clinicaltrials.ts` — add `searchTerminatedPriorTrials`; extend `FIELDS`
- `apps/agent/src/tools/clinicaltrials.test.ts` — tests for the new function
- `apps/agent/src/subgraphs/trial-eval/state.ts` — add `structuredCounterEvidence`; drop `counterEvidence`
- `apps/agent/src/subgraphs/trial-eval/graph.ts` — add `gather-counter-evidence` node; fan-in to `mechanism-plausibility`
- `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts` — drop counter-query
- `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts` — drop counter-query tests
- `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts` — import `pickSource` from util; pass `structuredCounterEvidence` to prompt
- `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts` — update fixtures
- `apps/agent/src/prompts/mechanism-plausibility.ts` — replace counter-block; drop forced `supports: "no"` instruction; dedupe TxGNN rendering
- `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts` — drop counter-evidence PMIDs from PMID-echo set; rewire concerns predicate
- `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts` — update fixtures
- `README.md` — update trial-eval-subgraph diagram + `literature-support` description
- `docs/topology.md` — update diagram, state table, `literature-support` section, `mechanism-plausibility` reads, `synthesize-match` PMID-echo and concerns text; add new `gather-counter-evidence` section

---

## Task 1: Add PriorTerminatedTrial and StructuredCounterEvidence schemas to shared

**Files:**
- Modify: `packages/shared/src/trial.ts` (after `MechanismEvidenceItemSchema`, line 58)

- [ ] **Step 1: Add the schemas**

Open `packages/shared/src/trial.ts` and add the following block immediately after the `MechanismEvidenceItem` export (around line 58):

```ts
// Mechanism-judging shape (NOT TrialCandidate — counter-evidence doesn't
// carry discovery provenance or eligibility fields). One per prior trial
// of the drug+condition retrieved from CT.gov with status TERMINATED,
// WITHDRAWN, or SUSPENDED. `whyStopped` is raw markup as CT.gov returns
// it; the LLM judges whether the reason is real biomedical
// counter-evidence vs administrative noise.
export const PriorTerminatedTrialSchema = z.object({
  nctId: z.string(),
  briefTitle: z.string(),
  conditions: z.array(z.string()),
  interventions: z.array(z.string()),
  phase: z.string().optional(),
  status: z.enum(["TERMINATED", "WITHDRAWN", "SUSPENDED"]),
  whyStopped: z.string().optional(),
  completionDate: z.string().optional(),
});
export type PriorTerminatedTrial = z.infer<typeof PriorTerminatedTrialSchema>;

// Reuses SafetyConcernSchema from eligibility for primeKgContraindications:
// the row shape (drugId, drugName, conditionId, conditionName, relation)
// is exactly what `findContraindicationsForDrugs` already returns and what
// `eligibility-check` already passes to its LLM. Same field, second consumer.
export const StructuredCounterEvidenceSchema = z.object({
  primeKgContraindications: z.array(SafetyConcernSchema),
  txGnnPredContraindication: z.number().nullable(),
  terminatedPriorTrials: z.array(PriorTerminatedTrialSchema),
});
export type StructuredCounterEvidence = z.infer<typeof StructuredCounterEvidenceSchema>;
```

You will also need to add `SafetyConcernSchema` to the top-of-file imports if `trial.ts` doesn't already import it. Look at the existing imports at the top of `trial.ts`. If `SafetyConcernSchema` is not imported, add:

```ts
import { SafetyConcernSchema } from "./eligibility.js";
```

- [ ] **Step 2: Verify the package builds**

Run: `pnpm --filter @clinical-trial-matching/shared build`
Expected: build succeeds, no type errors.

- [ ] **Step 3: Verify exports**

Run: `grep -n "PriorTerminatedTrial\|StructuredCounterEvidence" packages/shared/src/trial.ts`
Expected: at least 4 matches (two schema exports, two type exports).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/trial.ts
git commit -m "shared: add PriorTerminatedTrial and StructuredCounterEvidence schemas"
```

---

## Task 2: Add searchTerminatedPriorTrials to clinicaltrials.ts (TDD)

**Files:**
- Modify: `apps/agent/src/tools/clinicaltrials.ts`
- Modify: `apps/agent/src/tools/clinicaltrials.test.ts`

- [ ] **Step 1: Read existing test file to match style**

Run: `head -60 apps/agent/src/tools/clinicaltrials.test.ts`
Note: existing tests stub `global.fetch`. Match that pattern.

- [ ] **Step 2: Write the failing test**

Append to `apps/agent/src/tools/clinicaltrials.test.ts`:

```ts
describe("searchTerminatedPriorTrials", () => {
  it("queries CT.gov with intr + term + status filter and projects whyStopped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: "NCT01234567", briefTitle: "Trial of X" },
              statusModule: {
                overallStatus: "TERMINATED",
                whyStopped: "Stopped early at interim analysis for lack of efficacy.",
                completionDateStruct: { date: "2021-08-15" },
              },
              conditionsModule: { conditions: ["Non-small cell lung cancer"] },
              designModule: { phases: ["PHASE3"] },
              armsInterventionsModule: { interventions: [{ name: "Osimertinib" }] },
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await searchTerminatedPriorTrials({
      intervention: "osimertinib",
      condition: "non-small cell lung cancer",
    });

    expect(out).toEqual([
      {
        nctId: "NCT01234567",
        briefTitle: "Trial of X",
        conditions: ["Non-small cell lung cancer"],
        interventions: ["Osimertinib"],
        phase: "PHASE3",
        status: "TERMINATED",
        whyStopped: "Stopped early at interim analysis for lack of efficacy.",
        completionDate: "2021-08-15",
      },
    ]);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("query.intr=osimertinib");
    expect(calledUrl).toContain("query.term=non-small+cell+lung+cancer");
    expect(calledUrl).toContain("filter.overallStatus=TERMINATED%7CWITHDRAWN%7CSUSPENDED");
    expect(calledUrl).toContain("protocolSection.statusModule.whyStopped");
    vi.unstubAllGlobals();
  });

  it("returns [] when CT.gov returns no studies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ studies: [] }),
    }));

    const out = await searchTerminatedPriorTrials({
      intervention: "obscuredrug",
      condition: "rare disease",
    });
    expect(out).toEqual([]);
    vi.unstubAllGlobals();
  });
});
```

Also ensure `searchTerminatedPriorTrials` is imported at the top of the test file. Add to the import block:

```ts
import { searchTerminatedPriorTrials } from "./clinicaltrials.js";
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @clinical-trial-matching/agent test clinicaltrials.test.ts`
Expected: FAIL. Compile error: `searchTerminatedPriorTrials` is not exported.

- [ ] **Step 4: Extend FIELDS in clinicaltrials.ts**

In `apps/agent/src/tools/clinicaltrials.ts`, update the `FIELDS` constant (around line 50):

```ts
const FIELDS = [
  "protocolSection.identificationModule.nctId",
  "protocolSection.identificationModule.briefTitle",
  "protocolSection.statusModule.overallStatus",
  "protocolSection.statusModule.whyStopped",
  "protocolSection.statusModule.lastKnownStatus",
  "protocolSection.statusModule.completionDateStruct.date",
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
```

- [ ] **Step 5: Extend the CtgStudy type for the new fields**

In `apps/agent/src/tools/clinicaltrials.ts`, update the `statusModule` block inside `CtgStudy` (around line 142):

```ts
statusModule?: {
  overallStatus?: string;
  whyStopped?: string;
  lastKnownStatus?: string;
  completionDateStruct?: { date?: string };
};
```

- [ ] **Step 6: Implement searchTerminatedPriorTrials**

Add to `apps/agent/src/tools/clinicaltrials.ts` (after `searchClinicalTrials`, before `buildUrl`):

```ts
import type { PriorTerminatedTrial } from "@clinical-trial-matching/shared";

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
  params.set("fields", FIELDS);
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
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @clinical-trial-matching/agent test clinicaltrials.test.ts`
Expected: PASS, both new tests green.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/tools/clinicaltrials.ts apps/agent/src/tools/clinicaltrials.test.ts
git commit -m "tools/clinicaltrials: add searchTerminatedPriorTrials for counter-evidence"
```

---

## Task 3: Extract pickSource helper into shared util

**Files:**
- Create: `apps/agent/src/subgraphs/trial-eval/util/repurposing.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/util/repurposing.test.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts` (remove inline `pickSource`, import from util)

- [ ] **Step 1: Write the failing test**

Create `apps/agent/src/subgraphs/trial-eval/util/repurposing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { RepurposingCandidate } from "@clinical-trial-matching/shared";
import { pickSource } from "./repurposing.js";

function rc(id: string, predIndication: number): RepurposingCandidate {
  return {
    drug: { id, name: id, type: "drug" },
    originalIndications: [],
    predIndication,
    predContraindication: 0,
    supportingPaths: [],
    rationale: "",
  } as RepurposingCandidate;
}

describe("pickSource", () => {
  it("returns undefined when no candidate matches the drugIds", () => {
    expect(pickSource(["DB1"], [rc("DB2", 0.9)])).toBeUndefined();
  });

  it("returns the matching candidate when drugIds has one match", () => {
    const candidates = [rc("DB1", 0.5), rc("DB2", 0.9)];
    expect(pickSource(["DB2"], candidates)?.drug.id).toBe("DB2");
  });

  it("returns the highest-predIndication candidate when multiple match", () => {
    const candidates = [rc("DB1", 0.5), rc("DB2", 0.9), rc("DB3", 0.7)];
    expect(pickSource(["DB1", "DB2", "DB3"], candidates)?.drug.id).toBe("DB2");
  });

  it("treats missing predIndication as 0", () => {
    const a = { ...rc("DB1", 0), predIndication: undefined } as RepurposingCandidate;
    const b = rc("DB2", 0.1);
    expect(pickSource(["DB1", "DB2"], [a, b])?.drug.id).toBe("DB2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @clinical-trial-matching/agent test repurposing.test.ts`
Expected: FAIL. Module `./repurposing.js` not found.

- [ ] **Step 3: Create the util file**

Create `apps/agent/src/subgraphs/trial-eval/util/repurposing.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @clinical-trial-matching/agent test repurposing.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Remove the inline pickSource from mechanism-plausibility.ts**

In `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`:

Delete the inline `pickSource` function (currently at lines 143-152, the block starting with `function pickSource(`).

Add to the import block near the top of the file:

```ts
import { pickSource } from "../util/repurposing.js";
```

- [ ] **Step 6: Run the existing mechanism-plausibility tests to verify nothing broke**

Run: `pnpm --filter @clinical-trial-matching/agent test mechanism-plausibility.test.ts`
Expected: PASS, all existing tests still green (the extraction is behavior-preserving).

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/util/repurposing.ts apps/agent/src/subgraphs/trial-eval/util/repurposing.test.ts apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts
git commit -m "trial-eval: extract pickSource into shared util/repurposing"
```

---

## Task 4: Add structuredCounterEvidence to state (additive)

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/state.ts`

This task is intentionally additive — we keep `counterEvidence` alongside `structuredCounterEvidence` until all consumers have migrated. Task 11 deletes `counterEvidence`.

- [ ] **Step 1: Add the import**

In `apps/agent/src/subgraphs/trial-eval/state.ts`, extend the existing shared import to include the new type. The current import block is at lines 2-11. Replace:

```ts
import type {
  PatientProfile,
  TrialCandidate,
  TrialMatch,
  Mechanism,
  MechanismEvidenceItem,
  RepurposingCandidate,
  Citation,
  EligibilityAssessment,
} from "@clinical-trial-matching/shared";
```

with:

```ts
import type {
  PatientProfile,
  TrialCandidate,
  TrialMatch,
  Mechanism,
  MechanismEvidenceItem,
  RepurposingCandidate,
  Citation,
  EligibilityAssessment,
  StructuredCounterEvidence,
} from "@clinical-trial-matching/shared";
```

- [ ] **Step 2: Add the annotation**

In `apps/agent/src/subgraphs/trial-eval/state.ts`, add a new annotation immediately after the `counterEvidence` annotation (currently lines 55-58):

```ts
  structuredCounterEvidence: Annotation<StructuredCounterEvidence>({
    reducer: (_prev, next) => next,
    default: () => ({
      primeKgContraindications: [],
      txGnnPredContraindication: null,
      terminatedPriorTrials: [],
    }),
  }),
```

- [ ] **Step 3: Verify the agent package builds**

Run: `pnpm --filter @clinical-trial-matching/agent build`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Run the full trial-eval test suite to verify nothing regressed**

Run: `pnpm --filter @clinical-trial-matching/agent test subgraphs/trial-eval`
Expected: all tests pass (new field is unused so far).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/state.ts
git commit -m "trial-eval/state: add structuredCounterEvidence (additive)"
```

---

## Task 5: Create gather-counter-evidence node + tests (TDD)

**Files:**
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../tools/kg.js", () => ({
  resolveDrugByName: vi.fn(),
  findContraindicationsForDrugs: vi.fn(),
}));
vi.mock("../../../tools/clinicaltrials.js", () => ({
  searchTerminatedPriorTrials: vi.fn(),
}));
vi.mock("../../../tools/snomed-mondo.js", () => ({
  resolveSnomedCondition: vi.fn(),
}));

import { gatherCounterEvidence } from "./gather-counter-evidence.js";
import * as kg from "../../../tools/kg.js";
import * as ctg from "../../../tools/clinicaltrials.js";
import * as crosswalk from "../../../tools/snomed-mondo.js";
import type { TrialEvalStateType } from "../state.js";

function baseState(overrides: Partial<TrialEvalStateType> = {}): TrialEvalStateType {
  return {
    patientProfile: {
      ageYears: 60,
      sex: "F",
      conditions: [{ id: "snomed:254637007", display: "Non-small cell lung carcinoma" }],
      medications: [],
      priorTreatments: [],
      labs: [],
    },
    candidate: {
      nctId: "NCT99999999",
      title: "Trial",
      conditions: ["NSCLC"],
      interventions: ["Osimertinib"],
      status: "RECRUITING",
      locations: [],
      stdAges: [],
      discoveredVia: ["strategy"],
      repurposingDrugIds: [],
    } as unknown as TrialEvalStateType["candidate"],
    mechanisms: [{
      conditionId: "snomed:254637007",
      conditionName: "Non-small cell lung carcinoma",
      geneTargets: [],
      pathways: [],
    }] as TrialEvalStateType["mechanisms"],
    repurposingCandidates: [],
    eligibility: {
      inclusion: [], exclusion: [], overall: "unclear", safetyConcerns: [],
    },
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    counterEvidence: [],
    structuredCounterEvidence: {
      primeKgContraindications: [],
      txGnnPredContraindication: null,
      terminatedPriorTrials: [],
    },
    mechanismEvidence: [],
    counterEvidenceAddressed: null,
    evidenceAttempts: 0,
    matches: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(kg.resolveDrugByName).mockReset();
  vi.mocked(kg.findContraindicationsForDrugs).mockReset();
  vi.mocked(ctg.searchTerminatedPriorTrials).mockReset();
  vi.mocked(crosswalk.resolveSnomedCondition).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("gatherCounterEvidence", () => {
  it("collects PrimeKG contraindications, terminated trials, and TxGNN predContraindication", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      primekgNodeId: "MONDO:0005233", primekgNodeName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([{
      drugId: "DB09330", drugName: "osimertinib",
      conditionId: "MONDO:0005233", conditionName: "NSCLC",
      relation: "contraindication",
    }]);
    vi.mocked(ctg.searchTerminatedPriorTrials).mockResolvedValue([{
      nctId: "NCT01234567", briefTitle: "Prior",
      conditions: ["NSCLC"], interventions: ["Osimertinib"],
      phase: "PHASE3", status: "TERMINATED",
      whyStopped: "Stopped for lack of efficacy.",
      completionDate: "2021-08-15",
    }]);

    const state = baseState({
      candidate: {
        ...baseState().candidate,
        discoveredVia: ["repurposing"],
        repurposingDrugIds: ["DB09330"],
      } as TrialEvalStateType["candidate"],
      repurposingCandidates: [{
        drug: { id: "DB09330", name: "osimertinib", type: "drug" },
        originalIndications: ["NSCLC"],
        predIndication: 0.9,
        predContraindication: 0.81,
        supportingPaths: [],
        rationale: "",
      }] as TrialEvalStateType["repurposingCandidates"],
    });

    const out = await gatherCounterEvidence(state);

    expect(out.structuredCounterEvidence).toEqual({
      primeKgContraindications: [{
        drugId: "DB09330", drugName: "osimertinib",
        conditionId: "MONDO:0005233", conditionName: "NSCLC",
        relation: "contraindication",
      }],
      txGnnPredContraindication: 0.81,
      terminatedPriorTrials: [{
        nctId: "NCT01234567", briefTitle: "Prior",
        conditions: ["NSCLC"], interventions: ["Osimertinib"],
        phase: "PHASE3", status: "TERMINATED",
        whyStopped: "Stopped for lack of efficacy.",
        completionDate: "2021-08-15",
      }],
    });
  });

  it("returns null txGnnPredContraindication when no matching RepurposingCandidate", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      primekgNodeId: "MONDO:0005233", primekgNodeName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);
    vi.mocked(ctg.searchTerminatedPriorTrials).mockResolvedValue([]);

    const out = await gatherCounterEvidence(baseState());
    expect(out.structuredCounterEvidence?.txGnnPredContraindication).toBeNull();
  });

  it("soft-fails when PrimeKG throws — leaves contraindications empty, continues with CT.gov", async () => {
    vi.mocked(kg.resolveDrugByName).mockRejectedValue(new Error("neo4j down"));
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      primekgNodeId: "MONDO:0005233", primekgNodeName: "NSCLC",
    });
    vi.mocked(ctg.searchTerminatedPriorTrials).mockResolvedValue([{
      nctId: "NCT01", briefTitle: "T", conditions: [], interventions: [],
      status: "TERMINATED",
    }]);

    const out = await gatherCounterEvidence(baseState());
    expect(out.structuredCounterEvidence?.primeKgContraindications).toEqual([]);
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toHaveLength(1);
  });

  it("soft-fails when CT.gov throws — leaves terminatedPriorTrials empty", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      primekgNodeId: "MONDO:0005233", primekgNodeName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);
    vi.mocked(ctg.searchTerminatedPriorTrials).mockRejectedValue(new Error("ctgov 503"));

    const out = await gatherCounterEvidence(baseState());
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toEqual([]);
  });

  it("skips CT.gov entirely when candidate has no interventions", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue(null);
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      primekgNodeId: "MONDO:0005233", primekgNodeName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);

    const state = baseState({
      candidate: { ...baseState().candidate, interventions: [] } as TrialEvalStateType["candidate"],
    });
    const out = await gatherCounterEvidence(state);
    expect(ctg.searchTerminatedPriorTrials).not.toHaveBeenCalled();
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @clinical-trial-matching/agent test gather-counter-evidence.test.ts`
Expected: FAIL. Module `./gather-counter-evidence.js` not found.

- [ ] **Step 3: Implement the node**

Create `apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.ts`:

```ts
/**
 * # gather-counter-evidence (trial-eval subgraph)
 *
 * Collects structured biomedical counter-evidence for a candidate trial:
 *
 *   - PrimeKG (:drug)-[:contraindication]-(:disease) edges between each
 *     resolved trial intervention and the patient's mechanism conditions.
 *   - TxGNN `predContraindication` from the matching RepurposingCandidate
 *     (when the trial came through the repurposing channel).
 *   - CT.gov terminated / withdrawn / suspended prior trials of the drug +
 *     condition, with raw `whyStopped` text passed through unfiltered.
 *
 * Runs in parallel with `literature-support`. Both fan in to
 * `mechanism-plausibility`. Each fetcher is wrapped in a soft-fail so an
 * outage in one source doesn't kill the candidate's evaluation — failed
 * sources resolve to empty arrays / null and the prompt notes their
 * absence.
 *
 * Replaces the PubMed sentiment-keyword OR-query that previously
 * populated `state.counterEvidence`. See
 * docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md.
 */

import type { PriorTerminatedTrial, SafetyConcern } from "@clinical-trial-matching/shared";

import { searchTerminatedPriorTrials } from "../../../tools/clinicaltrials.js";
import { findContraindicationsForDrugs, resolveDrugByName } from "../../../tools/kg.js";
import { resolveSnomedCondition } from "../../../tools/snomed-mondo.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";
import { pickSource } from "../util/repurposing.js";

const MAX_INTERVENTIONS_IN_QUERY = 3;

export async function gatherCounterEvidence(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const repurposingContext = pickSource(
    state.candidate.repurposingDrugIds,
    state.repurposingCandidates,
  );

  const [primeKgContraindications, terminatedPriorTrials] = await Promise.all([
    safeFetchPrimeKgContraindications(state),
    safeFetchTerminatedPriorTrials(state),
  ]);

  return {
    structuredCounterEvidence: {
      primeKgContraindications,
      txGnnPredContraindication: repurposingContext?.predContraindication ?? null,
      terminatedPriorTrials,
    },
  };
}

async function safeFetchPrimeKgContraindications(
  state: TrialEvalStateType,
): Promise<SafetyConcern[]> {
  try {
    const drugIds: string[] = [];
    for (const name of state.candidate.interventions) {
      const node = await resolveDrugByName(name);
      if (node) drugIds.push(node.id);
    }
    const diseaseIds: string[] = [];
    for (const m of state.mechanisms) {
      const resolved = resolveSnomedCondition(m.conditionId);
      if (resolved) diseaseIds.push(resolved.primekgNodeId);
    }
    if (drugIds.length === 0 || diseaseIds.length === 0) return [];
    return await findContraindicationsForDrugs(drugIds, diseaseIds);
  } catch (err) {
    console.warn(
      `gather-counter-evidence: PrimeKG contraindication fetch failed for ${state.candidate.nctId}: ${errorMessage(err)}`,
    );
    return [];
  }
}

async function safeFetchTerminatedPriorTrials(
  state: TrialEvalStateType,
): Promise<PriorTerminatedTrial[]> {
  const interventions = state.candidate.interventions.slice(0, MAX_INTERVENTIONS_IN_QUERY);
  if (interventions.length === 0) return [];
  const condition =
    state.mechanisms[0]?.conditionName ??
    state.patientProfile.conditions[0]?.display ??
    "";
  if (!condition) return [];

  const queries = interventions.map((intervention) =>
    searchTerminatedPriorTrials({ intervention, condition }).catch((err) => {
      console.warn(
        `gather-counter-evidence: CT.gov terminated lookup failed for intervention=${intervention} (${state.candidate.nctId}): ${errorMessage(err)}`,
      );
      return [] as PriorTerminatedTrial[];
    }),
  );

  const results = await Promise.all(queries);
  // Dedupe by nctId across the per-intervention queries.
  const byNctId = new Map<string, PriorTerminatedTrial>();
  for (const list of results) {
    for (const t of list) if (!byNctId.has(t.nctId)) byNctId.set(t.nctId, t);
  }
  return [...byNctId.values()];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @clinical-trial-matching/agent test gather-counter-evidence.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.ts apps/agent/src/subgraphs/trial-eval/nodes/gather-counter-evidence.test.ts
git commit -m "trial-eval: add gather-counter-evidence node (structured signals)"
```

---

## Task 6: Wire gather-counter-evidence into the subgraph in parallel

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/graph.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/graph.test.ts`

- [ ] **Step 1: Read the existing graph wiring**

Run: `cat apps/agent/src/subgraphs/trial-eval/graph.ts`
Note the current topology: `eligibility-check → literature-support ⇄ decide-if-more-evidence → mechanism-plausibility → synthesize-match`.

- [ ] **Step 2: Update the graph**

Replace the contents of `apps/agent/src/subgraphs/trial-eval/graph.ts` with:

```ts
import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState } from "./state.js";
import { eligibilityCheck } from "./nodes/eligibility-check.js";
import { mechanismPlausibility } from "./nodes/mechanism-plausibility.js";
import { literatureSupport } from "./nodes/literature-support.js";
import { decideIfMoreEvidence } from "./nodes/decide-if-more-evidence.js";
import { gatherCounterEvidence } from "./nodes/gather-counter-evidence.js";
import { synthesizeMatch } from "./nodes/synthesize-match.js";

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("eligibility-check", eligibilityCheck)
  .addNode("literature-support", literatureSupport)
  .addNode("gather-counter-evidence", gatherCounterEvidence)
  .addNode("mechanism-plausibility", mechanismPlausibility)
  .addNode("synthesize-match", synthesizeMatch)
  .addEdge(START, "eligibility-check")
  // Fan out: literature-support (with decide-if-more cycle) and
  // gather-counter-evidence run in parallel. Both fan in to
  // mechanism-plausibility, which sees both literatureSupport and
  // structuredCounterEvidence.
  .addEdge("eligibility-check", "literature-support")
  .addEdge("eligibility-check", "gather-counter-evidence")
  .addConditionalEdges("literature-support", decideIfMoreEvidence, [
    "literature-support",
    "mechanism-plausibility",
  ])
  .addEdge("gather-counter-evidence", "mechanism-plausibility")
  .addEdge("mechanism-plausibility", "synthesize-match")
  .addEdge("synthesize-match", END)
  .compile();
```

- [ ] **Step 3: Run the graph tests**

Run: `pnpm --filter @clinical-trial-matching/agent test graph.test.ts`
Expected: PASS. If the test asserts on node names, you may need to add `"gather-counter-evidence"` to the expected list — update accordingly. If a test fails because a fan-in assertion expects only `literature-support` reaching `mechanism-plausibility`, update it to expect both `literature-support` and `gather-counter-evidence` as predecessors.

- [ ] **Step 4: Run the full trial-eval suite**

Run: `pnpm --filter @clinical-trial-matching/agent test subgraphs/trial-eval`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/graph.ts apps/agent/src/subgraphs/trial-eval/graph.test.ts
git commit -m "trial-eval/graph: fan out gather-counter-evidence in parallel with literature-support"
```

---

## Task 7: Update mechanism-plausibility prompt (structured counter-evidence block)

**Files:**
- Modify: `apps/agent/src/prompts/mechanism-plausibility.ts`

- [ ] **Step 1: Update the prompt signature**

In `apps/agent/src/prompts/mechanism-plausibility.ts`, update the `mechanismScorePrompt` signature (around line 58) to replace `counter: Citation[]` with `structuredCounterEvidence: StructuredCounterEvidence`. Also update the imports at the top to add `StructuredCounterEvidence` (drop `Citation` if it's no longer used after edits — it still is for `supporting`).

Replace lines 58-66 (the `export function mechanismScorePrompt` signature and the deletion of the `counter: Citation[]` parameter):

```ts
export function mechanismScorePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  kgPaths: KGPath[],
  supporting: Citation[],
  structuredCounterEvidence: StructuredCounterEvidence,
  repurposingContext: RepurposingCandidate | null,
): string {
```

Add `StructuredCounterEvidence` to the import block at the top of the file (alongside the other shared imports).

- [ ] **Step 2: Replace the counterBlock construction**

Delete the existing `counterBlock` definition (lines 79-82, which currently builds from `counter.map(...)`). Replace with a renderer that consumes the structured shape:

```ts
const counterBlock = formatStructuredCounterEvidence(structuredCounterEvidence);
```

- [ ] **Step 3: Add the formatter helper**

At the bottom of the file (after the existing `formatPath` helper), add:

```ts
function formatStructuredCounterEvidence(sce: StructuredCounterEvidence): string {
  const sections: string[] = [];

  if (sce.primeKgContraindications.length > 0) {
    sections.push(
      "  PrimeKG contraindications:",
      ...sce.primeKgContraindications.map(
        (c) => `    - ${c.drugName} (${c.drugId}) is annotated as contraindicated for ${c.conditionName} (${c.conditionId}).`,
      ),
    );
  }

  if (sce.txGnnPredContraindication !== null) {
    sections.push(
      "  TxGNN repurposing model:",
      `    predContraindication = ${sce.txGnnPredContraindication.toFixed(2)} (higher = TxGNN predicts this drug is contraindicated for the patient's disease; treat as a learned negative signal).`,
    );
  }

  if (sce.terminatedPriorTrials.length > 0) {
    sections.push(
      "  Prior terminated / withdrawn / suspended trials of this drug + condition (CT.gov):",
      ...sce.terminatedPriorTrials.map((t) => {
        const phaseStr = t.phase ? `phase ${t.phase.replace(/^PHASE/, "")}` : "phase unknown";
        const dateStr = t.completionDate ? ` ${t.completionDate}` : "";
        const reason = t.whyStopped?.trim() || "(no whyStopped reason provided)";
        return `    - ${t.nctId} [${phaseStr}, ${t.status}${dateStr}]: "${reason}"`;
      }),
      "",
      "  Judge each whyStopped on its merits. Real biomedical reasons (lack of efficacy,",
      "  futility, safety, toxicity, adverse events, dose-limiting toxicity) are",
      "  counter-evidence. Administrative reasons (low enrollment, funding withdrawn,",
      "  sponsor business decision, regulatory changes, protocol amendments) are NOT",
      "  counter-evidence — note them and discount.",
    );
  }

  if (sections.length === 0) return "  No structured counter-evidence retrieved.";
  return sections.join("\n");
}
```

- [ ] **Step 4: Update the prompt body**

Update the prompt body around line 111-112 (the line that currently says `"Counter-evidence from PubMed (papers describing failure / futility / toxicity / withdrawal):"`). Replace with:

```ts
    "Counter-evidence (structured signals):",
    counterBlock,
```

- [ ] **Step 5: Remove the forced supports='no' instruction**

In the `Return:` section near the bottom of the prompt (currently around lines 135-142), find these lines:

```ts
    "    Include at least one counter-evidence quote (supports: 'no') if any",
    "    counter-evidence is present.",
```

Delete those two lines entirely.

Then update the `counterEvidenceAddressed` instruction (currently around lines 141-142):

Replace:

```ts
    "  - counterEvidenceAddressed: if counter-evidence is present, one sentence",
    "    on whether/how it changes the score. Omit if no counter-evidence.",
```

with:

```ts
    "  - counterEvidenceAddressed: if any structured counter-evidence was present",
    "    and on-point (a real biomedical contraindication, a high TxGNN",
    "    predContraindication, or a prior trial terminated for a real biomedical",
    "    reason like lack of efficacy or toxicity), one sentence on whether/how",
    "    it affects the score. Omit if none was present or all retrieved signals",
    "    were administrative noise (low enrollment, funding, sponsor decision).",
```

- [ ] **Step 6: Dedupe TxGNN rendering in discoveryChannelBlock**

In `discoveryChannelBlock` (around line 146-181), the TxGNN section currently renders `predContraindication`. Find and delete the `predContraindication` line (around line 161):

```ts
      `    predContraindication: ${contra}   (higher = TxGNN predicts this drug is contraindicated; treat as a negative signal)`,
```

Also delete the local `contra` variable assignment a few lines above (`const contra = (repurposing.predContraindication ?? 0).toFixed(2);`). The `predContraindication` is now surfaced exclusively through the counter-evidence block.

- [ ] **Step 7: Soften the "Strong counter-evidence" weighting line**

In the "How to weight signals" block (around lines 126-127), update the strong-counter-evidence line:

Replace:

```ts
    "  - Strong counter-evidence significantly reduces the score regardless",
    "    of other signals.",
```

with:

```ts
    "  - Strong counter-evidence significantly reduces the score regardless",
    "    of other signals. An on-point PrimeKG contraindication or a phase-3",
    "    trial terminated for lack of efficacy against the same condition is",
    "    very strong counter-evidence.",
```

- [ ] **Step 8: Verify the prompt module builds**

Run: `pnpm --filter @clinical-trial-matching/agent build 2>&1 | head -40`
Expected: build succeeds. There will be a type error at the call site in `mechanism-plausibility.ts` (which we update next task) — that's expected and addressed in Task 8.

- [ ] **Step 9: Commit**

```bash
git add apps/agent/src/prompts/mechanism-plausibility.ts
git commit -m "prompts/mechanism-plausibility: render structured counter-evidence; drop forced supports=no"
```

---

## Task 8: Update mechanism-plausibility node to pass structuredCounterEvidence

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`

- [ ] **Step 1: Update the call site**

In `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`, find the `mechanismScorePrompt(` invocation (around line 98). Replace `state.counterEvidence` with `state.structuredCounterEvidence`:

Replace:

```ts
    const judgment = await judgeScore.invoke(
      mechanismScorePrompt(
        state.patientProfile,
        state.candidate,
        state.mechanisms,
        kgPaths,
        state.literatureSupport,
        state.counterEvidence,
        repurposingContext ?? null,
      ),
    );
```

with:

```ts
    const judgment = await judgeScore.invoke(
      mechanismScorePrompt(
        state.patientProfile,
        state.candidate,
        state.mechanisms,
        kgPaths,
        state.literatureSupport,
        state.structuredCounterEvidence,
        repurposingContext ?? null,
      ),
    );
```

- [ ] **Step 2: Update existing node tests**

Open `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`. Any test fixture that builds a state object needs a `structuredCounterEvidence` field with the default empty shape:

```ts
structuredCounterEvidence: {
  primeKgContraindications: [],
  txGnnPredContraindication: null,
  terminatedPriorTrials: [],
},
```

Add this field to every state fixture. Existing tests passing `counterEvidence: []` keep that field for now (it's still in state until Task 11).

If any test asserted on the prompt receiving `counterEvidence`, update the assertion to expect `structuredCounterEvidence`.

- [ ] **Step 3: Run the mechanism-plausibility tests**

Run: `pnpm --filter @clinical-trial-matching/agent test mechanism-plausibility.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full trial-eval suite to check nothing else regressed**

Run: `pnpm --filter @clinical-trial-matching/agent test subgraphs/trial-eval`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
git commit -m "trial-eval/mechanism-plausibility: pass structuredCounterEvidence to prompt"
```

---

## Task 9: Update synthesize-match (PMID-echo + concerns predicate)

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts`

- [ ] **Step 1: Update the PMID-echo set**

In `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts`, find the `knownPmids` Set construction (around lines 98-101):

Replace:

```ts
  const knownPmids = new Set<string>([
    ...state.literatureSupport.map((c) => c.pmid),
    ...state.counterEvidence.map((c) => c.pmid),
  ]);
```

with:

```ts
  // PMID-echo set is supporting-literature only — structured
  // counter-evidence has no PMIDs and `mechanismEvidence` legitimately
  // only draws from supporting citations after the counter-evidence
  // redesign.
  const knownPmids = new Set<string>(
    state.literatureSupport.map((c) => c.pmid),
  );
```

- [ ] **Step 2: Update the warn-log message**

A few lines below, find the warn-log message inside the filter callback (around line 106):

Replace:

```ts
      console.warn(
        `synthesize-match: dropping mechanismEvidence with unknown pmid=${e.pmid} (not in literatureSupport or counterEvidence)`,
      );
```

with:

```ts
      console.warn(
        `synthesize-match: dropping mechanismEvidence with unknown pmid=${e.pmid} (not in literatureSupport)`,
      );
```

- [ ] **Step 3: Rewire the counter-evidence-not-addressed concern**

Find the concern push (around line 119):

Replace:

```ts
  if (state.counterEvidence.length > 0 && !state.counterEvidenceAddressed) {
    concerns.push("counter-evidence present but not addressed in mechanism judgment");
  }
```

with:

```ts
  const sce = state.structuredCounterEvidence;
  const hasStructuredCounterEvidence =
    sce.primeKgContraindications.length > 0 ||
    sce.txGnnPredContraindication !== null ||
    sce.terminatedPriorTrials.length > 0;
  if (hasStructuredCounterEvidence && !state.counterEvidenceAddressed) {
    concerns.push("counter-evidence present but not addressed in mechanism judgment");
  }
```

- [ ] **Step 4: Update existing synthesize-match tests**

Open `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts`. Two concrete update patterns:

**Pattern A — every state fixture gets the new field.** Search for state-building helpers (typically `function buildState(...)` or inline state objects). Add the default empty `structuredCounterEvidence` to each:

```ts
structuredCounterEvidence: {
  primeKgContraindications: [],
  txGnnPredContraindication: null,
  terminatedPriorTrials: [],
},
```

**Pattern B — tests asserting the "counter-evidence not addressed" concern.** Find any test that currently looks like this (the exact citation shape may differ):

```ts
// OLD
const state = buildState({
  counterEvidence: [{ pmid: "12345", title: "...", year: 2020, url: "...", pubtype: [] }],
  counterEvidenceAddressed: null,
});
const result = await synthesizeMatch(state);
expect(result.matches[0].concerns).toContain("counter-evidence present but not addressed in mechanism judgment");
```

Convert it to use one of the new structured signals — `terminatedPriorTrials` is the easiest direct analog:

```ts
// NEW
const state = buildState({
  structuredCounterEvidence: {
    primeKgContraindications: [],
    txGnnPredContraindication: null,
    terminatedPriorTrials: [{
      nctId: "NCT01234567",
      briefTitle: "Prior failed trial",
      conditions: ["NSCLC"],
      interventions: ["Osimertinib"],
      status: "TERMINATED",
      whyStopped: "Lack of efficacy.",
    }],
  },
  counterEvidenceAddressed: null,
});
const result = await synthesizeMatch(state);
expect(result.matches[0].concerns).toContain("counter-evidence present but not addressed in mechanism judgment");
```

If a test instead exercises the case where the concern should NOT fire because `counterEvidenceAddressed` is non-null, keep `counterEvidenceAddressed: "Addressed via X"` and likewise populate one of the structured fields.

**Pattern C — PMID-echo filter tests.** Find any test that populates `counterEvidence: [{ pmid: "X", ... }]` and asserts a `mechanismEvidence` entry with `pmid: "X"` survives the filter. Move that PMID into `literatureSupport` instead:

```ts
// OLD
const state = buildState({
  literatureSupport: [],
  counterEvidence: [{ pmid: "X", title: "...", year: 2020, url: "...", pubtype: [] }],
  mechanismEvidence: [{ pmid: "X", quote: "...", supports: "no" }],
});
// expected: pmid X survives the filter

// NEW
const state = buildState({
  literatureSupport: [{ pmid: "X", title: "...", year: 2020, url: "...", pubtype: [] }],
  mechanismEvidence: [{ pmid: "X", quote: "...", supports: "no" }],
});
// expected: pmid X survives the filter (it's in literatureSupport now)
```

A test that relied on a PMID being valid solely because it was in `counterEvidence` should be deleted — that path no longer exists.

- [ ] **Step 5: Run the synthesize-match tests**

Run: `pnpm --filter @clinical-trial-matching/agent test synthesize-match.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full trial-eval suite**

Run: `pnpm --filter @clinical-trial-matching/agent test subgraphs/trial-eval`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts
git commit -m "trial-eval/synthesize-match: rewire PMID-echo and counter-evidence concern to structured shape"
```

---

## Task 10: Drop counter-query from literature-support

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts`

- [ ] **Step 1: Update the docstring at the top of the file**

In `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`, replace the top-of-file docstring (lines 1-17) with:

```ts
/**
 * # literature-support (trial-eval subgraph)
 *
 * PubMed citation lookup for a trial-patient match. Two-attempt loop
 * (bounded by `decide-if-more-evidence`): attempt 0 includes the
 * mechanism keyword; attempt 1 drops it to broaden. Citations are merged
 * with prior attempts (dedupe by pmid) so the broaden never reduces the
 * citation set.
 *
 * After each search we enrich citations with abstract excerpts via
 * `fetchAbstracts`. Both the PubMed search and the abstract fetch
 * soft-fail: a network error logs a warning and keeps the prior state.
 *
 * Counter-evidence is no longer a PubMed concern — it comes from
 * structured biomedical signals in `gather-counter-evidence`. See
 * docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md.
 *
 * No LLM call in this node. Pure PubMed retrieval; mechanism-plausibility
 * and synthesize-match consume the citation list.
 */
```

- [ ] **Step 2: Delete the counter-query constants and helper**

Delete `COUNTER_MAX_RESULTS` (line 27), `COUNTER_TERMS` (lines 29-37), and the entire `buildCounterQuery` function (lines 125-140).

- [ ] **Step 3: Simplify the node body**

Replace the node body (currently `literatureSupport` function) with:

```ts
export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const supportingQuery = buildSupportingQuery(state);
  const supportingResult = await safeSearch(supportingQuery, SUPPORTING_MAX_RESULTS, "supporting");

  let supporting = state.literatureSupport;
  if (supportingResult) {
    const enriched = await enrichWithAbstracts(supportingResult);
    supporting = mergeByPmid(state.literatureSupport, enriched);
  }

  return {
    literatureSupport: supporting,
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}
```

Note: the return no longer includes `counterEvidence`. The `state.counterEvidence` field still exists at this stage (we delete it in Task 11), so nothing breaks — the LangGraph reducer just keeps the prior default `[]`.

- [ ] **Step 4: Delete counter-query tests**

Open `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts` and delete any test that exercises the counter-query path (typically tests asserting `searchPubMed` is called twice, or that `counterEvidence` is populated, or that includes `failed`/`futility` in the query string). Look for the test names — anything containing "counter" should go.

- [ ] **Step 5: Run the literature-support tests**

Run: `pnpm --filter @clinical-trial-matching/agent test literature-support.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full trial-eval suite**

Run: `pnpm --filter @clinical-trial-matching/agent test subgraphs/trial-eval`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts
git commit -m "trial-eval/literature-support: drop PubMed counter-evidence query"
```

---

## Task 11: Remove counterEvidence field from state

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/state.ts`
- Modify: any remaining test fixtures referencing `counterEvidence` (likely already removed in Tasks 8, 9, 10)

- [ ] **Step 1: Find any remaining references**

Run: `grep -rn "counterEvidence[^A]" apps/agent/src packages/shared/src | grep -v "structuredCounterEvidence" | grep -v "counterEvidenceAddressed"`

Expected: only `state.ts` and possibly some test fixtures. If the grep returns matches outside `state.ts` and test files, audit those — `counterEvidenceAddressed` is a different field that stays. The remaining `counterEvidence` (Citation[]) references must go.

- [ ] **Step 2: Remove the state annotation**

In `apps/agent/src/subgraphs/trial-eval/state.ts`, delete the entire `counterEvidence` annotation block (currently lines 55-58):

```ts
  counterEvidence: Annotation<Citation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
```

Also remove `Citation` from the imports if it's no longer used. Check with: `grep -n "Citation" apps/agent/src/subgraphs/trial-eval/state.ts`. If `literatureSupport` still uses it, keep the import.

- [ ] **Step 3: Remove from any remaining test fixtures**

Run: `grep -l "counterEvidence:" apps/agent/src/**/*.test.ts | xargs grep -L "structuredCounterEvidence"`

This finds tests still setting the old field but not the new one. They should already be updated from Tasks 8/9 but spot-check. Delete the `counterEvidence: ...` lines from any fixtures that still have them.

- [ ] **Step 4: Build the agent package**

Run: `pnpm --filter @clinical-trial-matching/agent build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Run the full trial-eval suite**

Run: `pnpm --filter @clinical-trial-matching/agent test subgraphs/trial-eval`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/state.ts apps/agent/src/subgraphs/trial-eval/nodes/
git commit -m "trial-eval/state: remove counterEvidence (replaced by structuredCounterEvidence)"
```

---

## Task 12: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the trial-eval subgraph diagram**

In `README.md`, find the subgraph block (lines 44-60). Replace:

```
**trial-eval-subgraph** (one instance per candidate):

```
            eligibility-check
                    │
                    ▼
          mechanism-plausibility
                    │
                    ▼
           literature-support  ◀──┐
                    │             │
                    ▼             │
           < 3 citations? ────────┘
                    │  (attempts < 2)
                    ▼  (else)
             synthesize-match
```
```

with:

```
**trial-eval-subgraph** (one instance per candidate):

```
                  eligibility-check
                   │             │
                   ▼             ▼
          literature-support   gather-counter-evidence
                   │             │
            ┌──────┘             │
            ▼                    │
   < 3 citations? ──┐            │
       (attempts<2) │            │
                    └──┬─────────┘
                       ▼
              mechanism-plausibility
                       │
                       ▼
                synthesize-match
```
```

- [ ] **Step 2: Update the literature-support one-liner**

In the "**Per-trial evaluation subgraph**" bullet list (around line 80), find:

```
- `literature-support` — PubMed query for trial drug + condition + mechanism; collect citations.
```

Replace with:

```
- `literature-support` — PubMed query for trial drug + condition + mechanism; collect supporting citations. Runs in parallel with `gather-counter-evidence`.
- `gather-counter-evidence` — Collect structured biomedical counter-evidence: PrimeKG drug↔disease contraindication edges, TxGNN `predContraindication` (when surfaced via repurposing), and CT.gov terminated/withdrawn/suspended prior trials of the drug+condition with raw `whyStopped` text. Replaces the prior PubMed sentiment-keyword counter-query.
```

- [ ] **Step 3: Verify the README renders correctly**

Run: `grep -n "gather-counter-evidence" README.md`
Expected: at least 2 matches (one in the diagram, one in the bullet list).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: update trial-eval-subgraph diagram with gather-counter-evidence"
```

---

## Task 13: Update docs/topology.md

**Files:**
- Modify: `docs/topology.md`

- [ ] **Step 1: Update the subgraph diagram**

In `docs/topology.md`, find the diagram (lines 198-210). Replace:

```
START → eligibility-check → literature-support ─┐
                                  ↑             │
                                  │             ↓
                                  └── decide-if-more-evidence
                                                │ (proceed)
                                                ↓
                                       mechanism-plausibility
                                                ↓
                                       synthesize-match
                                                ↓
                                               END
```

with:

```
                       START
                         ↓
                  eligibility-check
                    │           │
                    ↓           ↓
       literature-support   gather-counter-evidence
              ↑    │              │
              │    ↓              │
   decide-if-more-evidence        │
              (cycle)             │
                   │ (proceed)    │
                   └──────┬───────┘
                          ↓
                 mechanism-plausibility
                          ↓
                   synthesize-match
                          ↓
                         END
```

- [ ] **Step 2: Update the subgraph state table**

In the state table (lines 216-230), replace the `counterEvidence` row:

```
| `counterEvidence` | `Citation[]` | Written by literature-support on attempt 0 only (negative/failure-language PubMed query); fed into the mechanism-plausibility prompt |
```

with:

```
| `structuredCounterEvidence` | `{ primeKgContraindications: SafetyConcern[]; txGnnPredContraindication: number \| null; terminatedPriorTrials: PriorTerminatedTrial[] }` | Written by gather-counter-evidence (single shot, no cycle). PrimeKG contraindication edges between trial drug + patient condition, TxGNN predContraindication (when repurposing channel), and CT.gov terminated/withdrawn/suspended prior trials of the drug+condition with raw `whyStopped` |
```

- [ ] **Step 3: Update the literature-support section**

In the `literature-support` section (lines 246-262):

- Replace the **Writes** line:
  ```
  **Writes:** `literatureSupport` (replace reducer; node-level dedupe-merge with prior), `counterEvidence` (attempt 0 only), increments `evidenceAttempts`
  ```
  with:
  ```
  **Writes:** `literatureSupport` (replace reducer; node-level dedupe-merge with prior), increments `evidenceAttempts`
  ```

- Delete the entire "Counter-evidence query (attempt 0 only)." paragraph (the block starting "After the supporting search, attempt 0 also runs a second PubMed query…").

- In the "Citations are **artifacts and evidence-grounding inputs**…" paragraph, remove the `+ counterEvidence` mention.

- In the closing line, replace:
  ```
  PubMed failure → state unchanged for this attempt, `evidenceAttempts++` regardless so the cycle bound still applies. Counter-evidence call failure is non-fatal: `counterEvidence` stays empty and the supporting-evidence write proceeds.
  ```
  with:
  ```
  PubMed failure → state unchanged for this attempt, `evidenceAttempts++` regardless so the cycle bound still applies.
  ```

- [ ] **Step 4: Insert the gather-counter-evidence section**

Immediately after the `literature-support` section (before `decide-if-more-evidence`), insert:

````markdown
### `gather-counter-evidence`

**Reads:** `patientProfile`, `candidate`, `mechanisms`, `repurposingCandidates`
**Writes:** `structuredCounterEvidence`
**Tools:** `kg.resolveDrugByName`, `tools/snomed-mondo.resolveSnomedCondition`, `kg.findContraindicationsForDrugs`, `clinicaltrials.searchTerminatedPriorTrials`

Runs in parallel with `literature-support` (both fan in to `mechanism-plausibility`). Collects three structured counter-evidence signals into a single `StructuredCounterEvidence` object:

1. **PrimeKG contraindication edges.** Resolves each trial intervention to a PrimeKG drug ID via `resolveDrugByName` (formulation-suffix-stripped exact match). Resolves each patient mechanism condition via the SNOMED→MONDO crosswalk. Calls `findContraindicationsForDrugs(drugIds, diseaseIds)` — same Cypher helper `eligibility-check` uses for its safety step.
2. **TxGNN `predContraindication`.** Picks the matching `RepurposingCandidate` via the shared `util/repurposing.ts::pickSource` (looking up `state.repurposingCandidates` by `state.candidate.repurposingDrugIds`). Returns the candidate's `predContraindication` field, or `null` if no candidate matches.
3. **CT.gov terminated/withdrawn/suspended prior trials.** For each trial intervention (capped at 3), one CT.gov query (`query.intr=<name>` + `query.term=<condition>` + `filter.overallStatus=TERMINATED|WITHDRAWN|SUSPENDED`, `pageSize=20`). `whyStopped` is projected from the v2 response and passed through to the LLM unfiltered — the judge decides whether each stop reason is biomedical counter-evidence vs administrative noise. Dedupe by `nctId` across the per-intervention queries.

**Soft-fail.** Each fetcher is independently wrapped: PrimeKG Cypher failure → `primeKgContraindications: []`, CT.gov failure (per-intervention) → empty contribution. The node always returns a `StructuredCounterEvidence` object; downstream consumers don't need to null-guard. CT.gov fetch is skipped entirely when the candidate has no interventions or no condition can be resolved.

**No cycle.** Unlike `literature-support`, this node runs once. Structured signals are deterministic; re-querying yields the same result.

**Why structured signals, not PubMed keywords.** See `docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md` (Motivation). Briefly: a free-text OR over sentiment vocabulary (`failed`, `no benefit`, `discontinued`, …) ANDed with drug+condition matches papers where any of those words appears anywhere — not whether the paper contradicts the drug-mechanism hypothesis. The prompt-side fix (don't force `supports: "no"`) only masks the bad inputs. The real fix is to feed counter-evidence from structured biomedical sources that have semantic meaning.
````

- [ ] **Step 5: Update mechanism-plausibility reads**

In the `mechanism-plausibility` section (around line 275), replace the **Reads** line:

```
**Reads:** `patientProfile`, `candidate`, `mechanisms`, `repurposingCandidates`, `literatureSupport`, `counterEvidence`
```

with:

```
**Reads:** `patientProfile`, `candidate`, `mechanisms`, `repurposingCandidates`, `literatureSupport`, `structuredCounterEvidence`
```

In the Path B description (around line 292), update the prompt-content description:

Replace:

```
The LLM prompt is **literature-grounded**: it receives the trial's intervention(s), the ranked mechanisms (compact gene/pathway layout), the KG paths, the supporting `literatureSupport` citations **grouped by relevance tier with their `abstractExcerpt`s**, and the `counterEvidence` citations (also with excerpts).
```

with:

```
The LLM prompt is **literature-grounded**: it receives the trial's intervention(s), the ranked mechanisms (compact gene/pathway layout), the KG paths, the supporting `literatureSupport` citations **grouped by relevance tier with their `abstractExcerpt`s**, and the `structuredCounterEvidence` block (PrimeKG contraindications, TxGNN `predContraindication`, and terminated prior trials with raw `whyStopped`).
```

A few lines below, update the `counterEvidenceAddressed` line:

Replace:

```
- `counterEvidenceAddressed` — required when `counterEvidence` is non-empty; an explicit reconciliation of the negative findings (e.g. "the failed trial used X dose; this trial uses Y"). Null when there was no counter-evidence to address.
```

with:

```
- `counterEvidenceAddressed` — populated when any structured counter-evidence was on-point (a real PrimeKG contraindication, a high TxGNN `predContraindication`, or a prior trial terminated for a real biomedical reason); an explicit reconciliation of the negative findings. Null when no counter-evidence was retrieved or all retrieved signals were administrative noise.
```

- [ ] **Step 6: Update synthesize-match references**

In the `synthesize-match` section (lines 303-346), update the PMID-echo paragraph (around line 331):

Replace:

```
Before assembling the match, synthesize-match takes `state.mechanismEvidence` from Path B and drops any entry whose PMID is not present in `literatureSupport ∪ counterEvidence`.
```

with:

```
Before assembling the match, synthesize-match takes `state.mechanismEvidence` from the unified judge and drops any entry whose PMID is not present in `literatureSupport`. (Counter-evidence has no PMIDs after the structured-signals redesign — it's KG / TxGNN / CT.gov-status rows, not papers.)
```

Update the deterministic-concerns paragraph (around line 335):

Replace:

```
- `"counter-evidence present but not addressed in mechanism judgment"` — when `counterEvidence.length > 0` and `counterEvidenceAddressed` is null/empty (Path B only).
```

with:

```
- `"counter-evidence present but not addressed in mechanism judgment"` — when `structuredCounterEvidence` has any non-empty source (PrimeKG contraindication present, TxGNN `predContraindication` non-null, or any terminated prior trial) and `counterEvidenceAddressed` is null/empty.
```

- [ ] **Step 7: Update "Where to look for what"**

In the table at the bottom (around line 364), add a row for this spec:

After the existing `2026-05-23-trial-eval-evidence-rigor.md` row, add:

```
| See the mechanism counter-evidence redesign spec | [docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md](./superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md) |
```

- [ ] **Step 8: Verify the doc**

Run: `grep -n "gather-counter-evidence\|structuredCounterEvidence" docs/topology.md`
Expected: many matches — diagram, state table, new section, mechanism-plausibility reads, synthesize-match concerns.

Run: `grep -n "counterEvidence[^A]" docs/topology.md | grep -v "structuredCounterEvidence"`
Expected: zero matches (every old `counterEvidence` reference is now `structuredCounterEvidence`).

- [ ] **Step 9: Commit**

```bash
git add docs/topology.md
git commit -m "docs/topology: replace PubMed counter-evidence with structured signals"
```

---

## Task 14: CT.gov synonym spot-check

This is a manual verification step (not code). Confirm that CT.gov's own intervention-name indexing covers the common synonym sets we rely on after deciding not to do client-side synonym expansion (spec Risks §1).

- [ ] **Step 1: Run the spot-check script**

For each of the three drug pairs below, query CT.gov for terminated/withdrawn/suspended trials and confirm the per-name result counts are similar (the canonical name should return at least as many hits as each synonym, since CT.gov should bridge them).

Run, one at a time:

```bash
for q in osimertinib AZD9291 Tagrisso; do
  echo "=== $q ==="
  curl -s "https://clinicaltrials.gov/api/v2/studies?query.intr=$q&filter.overallStatus=TERMINATED%7CWITHDRAWN%7CSUSPENDED&pageSize=1&countTotal=true" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("totalCount:", d.get("totalCount"))'
done
```

Repeat for `trastuzumab Herceptin Kanjinti` and `pembrolizumab MK-3475 Keytruda`.

- [ ] **Step 2: Evaluate**

If the canonical-name count is **roughly the union** (or close to it — within 20%) of the synonyms' counts, CT.gov is bridging them. Pass. No code change.

If the synonym counts are much higher than the canonical (meaning canonical does not subsume them), CT.gov's bridging is weak. Add a "two-query union" in `gather-counter-evidence`:
  - For each intervention, also resolve via `resolveDrugByName` and, if the PrimeKG canonical name differs from the trial's raw intervention string, issue a second CT.gov query with the canonical name. Dedupe results by `nctId` in the same Map as today.
  - Add a test case covering the two-query path.

- [ ] **Step 3: Document the result**

Add a short note to `docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md` under Risks §1 with the outcome: e.g. "Spot-checked 2026-05-XX: CT.gov bridges osimertinib/AZD9291/Tagrisso correctly (canonical count = N, synonym counts = M1/M2; canonical subsumes within 10%). No two-query union needed." Or document the gap and reference the follow-up code change.

- [ ] **Step 4: Commit (if doc updated or code added)**

```bash
git add docs/superpowers/specs/2026-05-24-mechanism-counter-evidence-design.md
git commit -m "spec: record CT.gov synonym spot-check result"
```

---

## Final verification

- [ ] Run the full test suite one final time:
  ```bash
  pnpm --filter @clinical-trial-matching/agent test
  pnpm --filter @clinical-trial-matching/shared test
  ```
  Expected: all green.

- [ ] Type-check the whole repo:
  ```bash
  pnpm --filter @clinical-trial-matching/agent build
  pnpm --filter @clinical-trial-matching/shared build
  ```
  Expected: no errors.

- [ ] Confirm no stragglers:
  ```bash
  grep -rn "counterEvidence[^A]" apps/agent/src packages/shared/src | grep -v "structuredCounterEvidence" | grep -v "counterEvidenceAddressed" | grep -v "\.md"
  ```
  Expected: zero matches (the old field is fully removed from code; doc-level references all updated).
