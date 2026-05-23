# Trial-eval subgraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five stub nodes in `apps/agent/src/subgraphs/trial-eval/` and the three missing tool methods (`pubmed.searchPubMed`, plus `kg.pathBetween`, `kg.findContraindicationsForDrugs`, `kg.resolveDrugByName`) with real implementations. The subgraph evaluates one CT.gov candidate trial against the patient profile, the kept mechanisms, and the repurposing-channel context, then emits one `TrialMatch` back to the parent's `matches` concat reducer.

**Architecture:** Four layers, bottom up.

1. **Schema layer (`packages/shared/src/eligibility.ts`):** new `SafetyConcernSchema`, extend `EligibilityAssessmentSchema` with `safetyConcerns: SafetyConcern[]`.
2. **Tools layer (`apps/agent/src/tools/`):** `pubmed.ts` becomes a real esearch+esummary client (no abstracts, no XML); `kg.ts` gains three new helpers (`pathBetween`, `findContraindicationsForDrugs`, `resolveDrugByName`) following the same conventions as the existing two.
3. **Prompts layer (`apps/agent/src/prompts/`):** real prompts + structured-output Zod schemas for `eligibility.ts`, `mechanism-plausibility.ts` (two schemas — Path A narrate-only and Path B score+narrate), and a new `match-narration.ts`.
4. **Subgraph nodes (`apps/agent/src/subgraphs/trial-eval/nodes/`):** real `eligibility-check`, `mechanism-plausibility` (channel-aware), `literature-support`, `synthesize-match`. `decide-if-more-evidence` is already correct and unchanged.

**Tech Stack:** TypeScript (strict, `bundler` module resolution), Node 24, pnpm workspaces (exact-pinned deps), Zod 4.4.3, LangGraph.js 1.3.2, `@langchain/openai` 1.4.6 (Haiku via OpenRouter), `neo4j-driver` 5.x (already pinned), vitest 4.1.7. No new runtime deps — `fetch` for PubMed is built into Node 24.

**Spec:** `docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md`. Every section of that spec maps to one or more tasks below; cross-references inline.

**Conventions referenced:** `docs/codebase-conventions.md` (file layout, naming, error handling, test patterns), `CLAUDE.md` (exact-pinned versions — but this plan adds no deps). Test patterns mirror `apps/agent/src/nodes/find-repurposing-candidates.test.ts` for LLM/data-fixture mocking, `apps/agent/src/tools/kg.test.ts` for Neo4j-driver substitution via `setDriver`, and `apps/agent/src/tools/clinicaltrials.test.ts` for fetch-mocking patterns.

---

## File map

**Create:**
- `apps/agent/src/tools/pubmed.test.ts` — fetch-mocked unit tests.
- `apps/agent/src/tools/__fixtures__/pubmed-esearch.json` — sample esearch JSON.
- `apps/agent/src/tools/__fixtures__/pubmed-esummary.json` — sample esummary JSON.
- `apps/agent/src/prompts/eligibility.test.ts` — prompt-structure tests.
- `apps/agent/src/prompts/mechanism-plausibility.test.ts` — prompt-structure tests.
- `apps/agent/src/prompts/match-narration.ts` — synthesize-match prompt + schema (new file).
- `apps/agent/src/prompts/match-narration.test.ts` — prompt-structure tests.
- `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.test.ts`
- `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`
- `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts`
- `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts`

**Modify:**
- `packages/shared/src/eligibility.ts` — add `SafetyConcernSchema`; extend `EligibilityAssessmentSchema`.
- `apps/agent/src/tools/pubmed.ts` — replace stub with real esearch+esummary client.
- `apps/agent/src/tools/kg.ts` — add three new helpers; export a test seam for `resolveDrugByName`'s name cache.
- `apps/agent/src/tools/kg.test.ts` — extend with tests for the three new helpers.
- `apps/agent/src/prompts/eligibility.ts` — replace stub with real prompt + schema.
- `apps/agent/src/prompts/mechanism-plausibility.ts` — replace stub with both prompts + both schemas.
- `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.ts` — replace stub.
- `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts` — replace stub (channel-aware).
- `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts` — replace stub.
- `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts` — replace stub.
- `docs/topology.md` — document the implemented score formula, eligibility gate, channel split, and `safetyConcerns` field.

---

## Execution order

Bottom-up: schema → tools → prompts → nodes → docs. Each task is independently committable and each task's tests pass before the next starts.

```
Task 1 (schema)
   │
   ├──► Task 2 (pubmed tool)        ──┐
   │                                  │
   └──► Task 3 (kg tool extensions)   │
              │                       │
              ▼                       ▼
        Task 4 (eligibility       Task 5 (mechanism-     Task 6 (match-narration
                prompt)                  plausibility           prompt)
              │                          prompt)                │
              │                       │                         │
              ▼                       ▼                         ▼
        Task 7 (eligibility-      Task 8 (mechanism-       Task 9 (literature-
                check node)              plausibility             support node)
              │                          node)                   │
              │                       │                         │
              └────────────────┬──────┴─────────────────────────┘
                               ▼
                        Task 10 (synthesize-match node)
                               │
                               ▼
                        Task 11 (topology doc)
```

Tasks 2 and 3 can run in parallel (independent tools); same for prompts 4/5/6. The plan serializes them for review clarity, but a parallel implementer can interleave.

---

## Task 1: Shared schema extensions — `SafetyConcern`

**Spec ref:** *Design decisions* (Safety step row); *Node-by-node detail* → `eligibility-check` → Schema work; *State shape changes* → `packages/shared/src/eligibility.ts`.

**Files:**
- Modify: `packages/shared/src/eligibility.ts`

### Step 1: Add `SafetyConcernSchema` and extend `EligibilityAssessmentSchema`

Edit `packages/shared/src/eligibility.ts`. Append the new schema after `OverallEligibilitySchema`, and extend `EligibilityAssessmentSchema`:

```ts
// Surfaces from the deterministic PrimeKG safety step inside
// `eligibility-check`: each entry represents a `drug -[:contraindication]-
// disease` edge between a trial intervention and an active patient
// condition. `relation` is a single-element enum because the PrimeKG
// subset (per `pnpm kg:build-subset`) dropped `side_effect` nodes/edges;
// the enum is shaped to extend later without breaking consumers.
export const SafetyConcernSchema = z.object({
  drugId: z.string(),
  drugName: z.string(),
  conditionId: z.string(),
  conditionName: z.string(),
  relation: z.enum(["contraindication"]),
});
export type SafetyConcern = z.infer<typeof SafetyConcernSchema>;

export const EligibilityAssessmentSchema = z.object({
  inclusion: z.array(CriterionAssessmentSchema),
  exclusion: z.array(CriterionAssessmentSchema),
  overall: OverallEligibilitySchema,
  safetyConcerns: z.array(SafetyConcernSchema).default([]),
});
export type EligibilityAssessment = z.infer<typeof EligibilityAssessmentSchema>;
```

### Step 2: Run typecheck

```bash
pnpm -r typecheck
```

Expected: PASS. `TrialMatch.eligibility` already references `EligibilityAssessmentSchema`; the extension flows through without further wiring. The compile-time `_AgentStateMatchesGraphState` guard in `apps/agent/src/state.ts` continues to hold because `matches: TrialMatch[]` derives from the shared schema.

### Step 3: Commit

```bash
git add packages/shared/src/eligibility.ts
git commit -m "Add SafetyConcern schema + extend EligibilityAssessment with safetyConcerns"
```

---

## Task 2: `tools/pubmed.ts` — esearch + esummary client

**Spec ref:** *Tool implementations* → `tools/pubmed.ts::searchPubMed`. *Risks* item 7 (no abstracts in v1).

**Files:**
- Modify: `apps/agent/src/tools/pubmed.ts`
- Create: `apps/agent/src/tools/pubmed.test.ts`
- Create: `apps/agent/src/tools/__fixtures__/pubmed-esearch.json`
- Create: `apps/agent/src/tools/__fixtures__/pubmed-esummary.json`

### Step 1: Create response fixtures

Create `apps/agent/src/tools/__fixtures__/pubmed-esearch.json`:

```json
{
  "header": { "type": "esearch", "version": "0.3" },
  "esearchresult": {
    "count": "3",
    "retmax": "3",
    "retstart": "0",
    "idlist": ["39603809", "39463445", "39298753"],
    "translationset": [],
    "querytranslation": "osimertinib AND EGFR AND non-small cell lung carcinoma"
  }
}
```

Create `apps/agent/src/tools/__fixtures__/pubmed-esummary.json`:

```json
{
  "header": { "type": "esummary", "version": "0.3" },
  "result": {
    "uids": ["39603809", "39463445", "39298753"],
    "39603809": {
      "uid": "39603809",
      "pubdate": "2024 Nov 28",
      "epubdate": "2024 Nov 28",
      "source": "N Engl J Med",
      "authors": [
        { "name": "Smith J", "authtype": "Author", "clusterid": "" },
        { "name": "Doe J", "authtype": "Author", "clusterid": "" }
      ],
      "lastauthor": "Doe J",
      "title": "Osimertinib versus chemotherapy in EGFR-mutated NSCLC.",
      "volume": "391",
      "issue": "22",
      "pages": "2057-2068",
      "pubtype": ["Journal Article", "Randomized Controlled Trial"],
      "articleids": [
        { "idtype": "pubmed", "value": "39603809" },
        { "idtype": "doi", "value": "10.1056/NEJMoa2400000" }
      ],
      "fulljournalname": "The New England journal of medicine"
    },
    "39463445": {
      "uid": "39463445",
      "pubdate": "2024",
      "source": "Lancet Oncol",
      "authors": [{ "name": "Lee K", "authtype": "Author", "clusterid": "" }],
      "title": "EGFR T790M resistance mechanisms in NSCLC.",
      "pubtype": ["Journal Article"],
      "articleids": [
        { "idtype": "pubmed", "value": "39463445" },
        { "idtype": "doi", "value": "10.1016/S1470-2045(24)00000-0" }
      ],
      "fulljournalname": "The Lancet. Oncology"
    },
    "39298753": {
      "uid": "39298753",
      "pubdate": "garbage-pubdate",
      "source": "J Clin Oncol",
      "authors": [],
      "title": "Brain penetration of third-generation EGFR inhibitors.",
      "pubtype": ["Review"],
      "articleids": [{ "idtype": "pubmed", "value": "39298753" }],
      "fulljournalname": "Journal of clinical oncology"
    }
  }
}
```

(The third entry's `pubdate: "garbage-pubdate"` and missing DOI cover the lenient-parse path the implementation must handle.)

### Step 2: Write failing tests

Create `apps/agent/src/tools/pubmed.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { searchPubMed } from "./pubmed.js";
import esearchFixture from "./__fixtures__/pubmed-esearch.json" with { type: "json" };
import esummaryFixture from "./__fixtures__/pubmed-esummary.json" with { type: "json" };

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
  delete process.env.PUBMED_API_KEY;
});

describe("searchPubMed", () => {
  it("issues esearch then esummary and maps results into Citation[]", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));

    const citations = await searchPubMed("osimertinib AND EGFR", 3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const esearchUrl = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(esearchUrl.pathname).toContain("esearch.fcgi");
    expect(esearchUrl.searchParams.get("db")).toBe("pubmed");
    expect(esearchUrl.searchParams.get("term")).toBe("osimertinib AND EGFR");
    expect(esearchUrl.searchParams.get("retmax")).toBe("3");
    expect(esearchUrl.searchParams.get("retmode")).toBe("json");

    const esummaryUrl = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(esummaryUrl.pathname).toContain("esummary.fcgi");
    expect(esummaryUrl.searchParams.get("id")).toBe("39603809,39463445,39298753");

    expect(citations).toHaveLength(3);
    const first = citations[0]!;
    expect(first.pmid).toBe("39603809");
    expect(first.title).toContain("Osimertinib");
    expect(first.year).toBe(2024);
    expect(first.url).toBe("https://pubmed.ncbi.nlm.nih.gov/39603809/");
  });

  it("returns [] when esearch returns no PMIDs (skips esummary)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse({
        header: { type: "esearch", version: "0.3" },
        esearchresult: { count: "0", retmax: "0", retstart: "0", idlist: [] },
      }),
    );
    const out = await searchPubMed("very rare query", 10);
    expect(out).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves PMID order in the output (the esearch ranking)", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const out = await searchPubMed("x", 3);
    expect(out.map((c) => c.pmid)).toEqual(["39603809", "39463445", "39298753"]);
  });

  it("leaves year undefined when pubdate is unparseable", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const out = await searchPubMed("x", 3);
    const third = out.find((c) => c.pmid === "39298753")!;
    expect(third.year).toBeUndefined();
  });

  it("appends api_key when PUBMED_API_KEY is set", async () => {
    process.env.PUBMED_API_KEY = "test-key";
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    await searchPubMed("x", 3);
    const esearchUrl = new URL(fetchSpy.mock.calls[0]![0] as string);
    const esummaryUrl = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(esearchUrl.searchParams.get("api_key")).toBe("test-key");
    expect(esummaryUrl.searchParams.get("api_key")).toBe("test-key");
  });

  it("retries on 429 with backoff (mirrors clinicaltrials)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse({}, { status: 429 }))
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const promise = searchPubMed("x", 3);
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out).toHaveLength(3);
  });

  it("throws after exhausting retries on persistent 503", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(makeResponse({}, { status: 503 }));
    const promise = searchPubMed("x", 3);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toThrow(/PubMed.*503/);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
```

### Step 3: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/tools/pubmed.test.ts
```

Expected: FAIL — current `searchPubMed` throws "not implemented".

### Step 4: Implement the client

Replace `apps/agent/src/tools/pubmed.ts` entirely:

```ts
/**
 * # tools/pubmed
 *
 * NCBI E-utilities client for PubMed citation lookup. Two-step:
 *
 *   1. `esearch.fcgi?db=pubmed&term=<q>&retmax=<n>&retmode=json`
 *      → `{ esearchresult: { idlist: string[] } }`.
 *   2. `esummary.fcgi?db=pubmed&id=<csv>&retmode=json`
 *      → `{ result: { uids: string[], <pmid>: { title, pubdate, articleids, ... } } }`.
 *
 * No abstract retrieval in v1 (efetch returns XML and bloats responses).
 * `Citation.abstractExcerpt` stays undefined. Revisit if synthesize-match
 * starts writing "no abstract context" in summaries.
 *
 * ## Rate limits and retries
 *
 * PubMed allows 3 req/sec without an API key, 10 req/sec with one (set
 * `PUBMED_API_KEY` env). We retry 429/503 with exponential backoff
 * (3 attempts, 1s/2s/4s), honoring `Retry-After`. Mirrors
 * `tools/clinicaltrials.ts`'s strategy.
 */

import type { Citation } from "@clinical-trial-matching/shared";

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const PUBMED_BASE = "https://pubmed.ncbi.nlm.nih.gov";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const RETRYABLE_STATUSES = new Set([429, 503]);

type EsearchResponse = {
  esearchresult?: { idlist?: string[] };
};

type EsummaryEntry = {
  uid?: string;
  title?: string;
  pubdate?: string;
  articleids?: Array<{ idtype?: string; value?: string }>;
};

type EsummaryResponse = {
  result?: { uids?: string[] } & Record<string, EsummaryEntry>;
};

export async function searchPubMed(
  query: string,
  maxResults = 10,
): Promise<Citation[]> {
  const pmids = await esearch(query, maxResults);
  if (pmids.length === 0) return [];
  return await esummary(pmids);
}

async function esearch(query: string, retmax: number): Promise<string[]> {
  const url = appendApiKey(
    `${ESEARCH_URL}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&retmode=json`,
  );
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`PubMed esearch ${res.status} for ${url}`);
  const body = (await res.json()) as EsearchResponse;
  return body.esearchresult?.idlist ?? [];
}

async function esummary(pmids: string[]): Promise<Citation[]> {
  const url = appendApiKey(
    `${ESUMMARY_URL}?db=pubmed&id=${pmids.join(",")}&retmode=json`,
  );
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`PubMed esummary ${res.status} for ${url}`);
  const body = (await res.json()) as EsummaryResponse;
  const result = body.result;
  if (!result) return [];

  // Preserve esearch's ranking by iterating `pmids`, not `result.uids`.
  const out: Citation[] = [];
  for (const pmid of pmids) {
    const entry = result[pmid];
    if (!entry || typeof entry !== "object") continue;
    out.push(toCitation(pmid, entry));
  }
  return out;
}

function toCitation(pmid: string, entry: EsummaryEntry): Citation {
  return {
    pmid,
    title: entry.title ?? "(no title)",
    year: parseYear(entry.pubdate),
    url: `${PUBMED_BASE}/${pmid}/`,
  };
}

function parseYear(pubdate: string | undefined): number | undefined {
  if (!pubdate) return undefined;
  const m = /^\d{4}/.exec(pubdate);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function appendApiKey(url: string): string {
  const key = process.env.PUBMED_API_KEY;
  if (!key) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}api_key=${encodeURIComponent(key)}`;
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
      `pubmed: ${res.status} on ${url}, backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
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
```

### Step 5: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/tools/pubmed.test.ts
```

Expected: PASS, all 7 test cases.

### Step 6: Commit

```bash
git add apps/agent/src/tools/pubmed.ts apps/agent/src/tools/pubmed.test.ts apps/agent/src/tools/__fixtures__/pubmed-esearch.json apps/agent/src/tools/__fixtures__/pubmed-esummary.json
git commit -m "Implement PubMed esearch+esummary client (no abstracts in v1)"
```

---

## Task 3: `tools/kg.ts` — pathBetween + findContraindicationsForDrugs + resolveDrugByName

**Spec ref:** *Tool implementations* → all three `kg.ts::*` sections. *Risks* items 1 (drug-name brittleness), 2 (contraindication coverage), 3 (pathBetween cost on dense nodes).

**Files:**
- Modify: `apps/agent/src/tools/kg.ts`
- Modify: `apps/agent/src/tools/kg.test.ts`

### Step 1: Write failing tests

Append to `apps/agent/src/tools/kg.test.ts` (after the existing tests):

```ts
// ---- pathBetween ----

import {
  pathBetween,
  findContraindicationsForDrugs,
  resolveDrugByName,
  setDrugNameIndexForTests,
} from "./kg.js";

describe("pathBetween", () => {
  it("returns KGPath[] from variable-hop driver result", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "MATCH p = (a:Node",
        rows: [
          {
            p: {
              segments: [
                {
                  start: { properties: { id: "DB09330", name: "osimertinib", type: "drug" } },
                  relationship: { type: "target" },
                  end: { properties: { id: "EGFR", name: "EGFR", type: "gene/protein" } },
                },
                {
                  start: { properties: { id: "EGFR", name: "EGFR", type: "gene/protein" } },
                  relationship: { type: "associated with" },
                  end: { properties: { id: "MONDO:0005233", name: "non-small cell lung carcinoma", type: "disease" } },
                },
              ],
            },
          },
        ],
      },
    ]);
    setDriver(driver);
    const paths = await pathBetween("DB09330", "MONDO:0005233", 3, 5);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.nodes).toEqual([
      { id: "DB09330", name: "osimertinib", type: "drug" },
      { id: "EGFR", name: "EGFR", type: "gene_protein" },
      { id: "MONDO:0005233", name: "non-small cell lung carcinoma", type: "disease" },
    ]);
    expect(paths[0]!.edges).toEqual([
      { source: "DB09330", target: "EGFR", relation: "target" },
      { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
    ]);
    // Verify params are passed as integers via neo4j.int (LIMIT FLOAT trap).
    expect(calls[0]!.params.maxHops).toMatchObject({ low: 3 });
    expect(calls[0]!.params.pathLimit).toMatchObject({ low: 5 });
  });

  it("returns [] on no paths (no throw)", async () => {
    const { driver } = makeMockDriver([
      { query: "MATCH p = (a:Node", rows: [] },
    ]);
    setDriver(driver);
    const paths = await pathBetween("DB09330", "MONDO:9999999");
    expect(paths).toEqual([]);
  });
});

// ---- findContraindicationsForDrugs ----

describe("findContraindicationsForDrugs", () => {
  it("returns SafetyConcern[] keyed by drug × disease intersection", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "contraindication",
        rows: [
          {
            drugId: "DB00072",
            drugName: "trastuzumab",
            conditionId: "MONDO:0007254",
            conditionName: "breast cancer",
          },
        ],
      },
    ]);
    setDriver(driver);
    const concerns = await findContraindicationsForDrugs(
      ["DB00072", "DB00563"],
      ["MONDO:0007254", "MONDO:0008383"],
    );
    expect(concerns).toEqual([
      {
        drugId: "DB00072",
        drugName: "trastuzumab",
        conditionId: "MONDO:0007254",
        conditionName: "breast cancer",
        relation: "contraindication",
      },
    ]);
    expect(calls[0]!.params.drugIds).toEqual(["DB00072", "DB00563"]);
    expect(calls[0]!.params.diseaseIds).toEqual(["MONDO:0007254", "MONDO:0008383"]);
    // Verify the Cypher matches the verbatim relation name.
    expect(calls[0]!.query).toContain("contraindication");
  });

  it("returns [] on empty input (skips Cypher)", async () => {
    const { driver, calls } = makeMockDriver([]);
    setDriver(driver);
    expect(await findContraindicationsForDrugs([], ["MONDO:0007254"])).toEqual([]);
    expect(await findContraindicationsForDrugs(["DB00072"], [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---- resolveDrugByName ----

describe("resolveDrugByName", () => {
  afterEach(() => setDrugNameIndexForTests(null));

  it("looks up via the cached name index (no driver call after first warm)", async () => {
    setDrugNameIndexForTests(
      new Map([
        ["osimertinib", { id: "DB09330", name: "osimertinib", type: "drug" }],
        ["trastuzumab", { id: "DB00072", name: "trastuzumab", type: "drug" }],
      ]),
    );
    const out = await resolveDrugByName("Osimertinib");
    expect(out).toEqual({ id: "DB09330", name: "osimertinib", type: "drug" });
  });

  it("strips dose/formulation suffixes from the input", async () => {
    setDrugNameIndexForTests(
      new Map([["osimertinib", { id: "DB09330", name: "osimertinib", type: "drug" }]]),
    );
    expect(await resolveDrugByName("osimertinib 80mg tablet")).toMatchObject({ id: "DB09330" });
    expect(await resolveDrugByName("Osimertinib 80 mg")).toMatchObject({ id: "DB09330" });
  });

  it("returns null on miss", async () => {
    setDrugNameIndexForTests(new Map());
    expect(await resolveDrugByName("imaginarium")).toBeNull();
  });

  it("populates the index from Cypher on first call when empty", async () => {
    const { driver, calls } = makeMockDriver([
      {
        query: "MATCH (d:Node {type: 'drug'})",
        rows: [
          { id: "DB00072", name: "trastuzumab" },
          { id: "DB09330", name: "Osimertinib" },
        ],
      },
    ]);
    setDriver(driver);
    setDrugNameIndexForTests(null); // force lazy-load
    const out = await resolveDrugByName("osimertinib");
    expect(out).toMatchObject({ id: "DB09330", name: "Osimertinib" });
    expect(calls).toHaveLength(1);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/tools/kg.test.ts
```

Expected: FAIL — none of the new functions exist.

### Step 3: Implement the three helpers

Edit `apps/agent/src/tools/kg.ts`. Add imports and append after the existing helpers:

```ts
import type { SafetyConcern } from "@clinical-trial-matching/shared";

// ---------- pathBetween ----------
//
// Variable-hop sample paths between two PrimeKG nodes. `LIMIT $pathLimit`
// keeps the result bounded; `maxHops = 3` covers drug → gene → process →
// disease and the symmetric form. PrimeKG edges are undirected (per
// docs/primekg-querying.md) — the `*1..N` syntax matches both directions.
//
// `neo4j.int(...)` is required for the LIMIT param: the driver maps raw
// JS numbers to FLOAT and Cypher LIMIT rejects FLOAT.

const CYPHER_PATH_BETWEEN = `
MATCH p = (a:Node {id: $fromId})-[*1..$maxHops]-(b:Node {id: $toId})
RETURN p
LIMIT $pathLimit
` as const;

export async function pathBetween(
  fromId: string,
  toId: string,
  maxHops = 3,
  pathLimit = 5,
): Promise<KGPath[]> {
  const session = openSession();
  try {
    const result = await session.run(CYPHER_PATH_BETWEEN, {
      fromId,
      toId,
      maxHops: neo4j.int(maxHops),
      pathLimit: neo4j.int(pathLimit),
    });
    return result.records.map((r) => pathFromDriverPath(r.get("p")));
  } finally {
    await session.close();
  }
}

// neo4j-driver's Path object exposes `segments[]`; each segment carries
// {start, relationship, end}. We flatten to {nodes[], edges[]} for the
// shared KGPath shape; types normalize via NODE_TYPE_FROM_KG.
type DriverNode = { properties: { id: string; name: string; type: string } };
type DriverRel = { type: string };
type DriverSegment = { start: DriverNode; relationship: DriverRel; end: DriverNode };
type DriverPath = { segments: DriverSegment[] };

function pathFromDriverPath(p: DriverPath): KGPath {
  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  if (p.segments.length === 0) return { nodes, edges };
  nodes.push(driverNodeToKGNode(p.segments[0]!.start));
  for (const seg of p.segments) {
    nodes.push(driverNodeToKGNode(seg.end));
    edges.push({
      source: seg.start.properties.id,
      target: seg.end.properties.id,
      relation: seg.relationship.type,
    });
  }
  return { nodes, edges };
}

function driverNodeToKGNode(n: DriverNode): KGNode {
  return {
    id: n.properties.id,
    name: n.properties.name,
    type: normalizeNodeType(n.properties.type),
  };
}

// ---------- findContraindicationsForDrugs ----------
//
// Deterministic safety lookup for `eligibility-check`'s step 1. Returns
// rows for every (drug, disease) pair in the input that has a
// `contraindication` edge in PrimeKG. `DISTINCT` because the undirected
// match yields duplicate rows.
//
// `side_effect` is NOT in this query: the subset built by
// `pnpm kg:build-subset` drops side-effect nodes/edges. The single-element
// enum on `SafetyConcern.relation` documents this; the spec corrects the
// drug-eval v2 reference to `side_effect`.

const CYPHER_CONTRAINDICATIONS = `
MATCH (d:Node {type: 'drug'})-[:\`contraindication\`]-(c:Node {type: 'disease'})
WHERE d.id IN $drugIds AND c.id IN $diseaseIds
RETURN DISTINCT d.id AS drugId, d.name AS drugName,
                c.id AS conditionId, c.name AS conditionName
` as const;

export async function findContraindicationsForDrugs(
  drugIds: string[],
  diseaseIds: string[],
): Promise<SafetyConcern[]> {
  if (drugIds.length === 0 || diseaseIds.length === 0) return [];
  const session = openSession();
  try {
    const result = await session.run(CYPHER_CONTRAINDICATIONS, {
      drugIds,
      diseaseIds,
    });
    return result.records.map((r) => ({
      drugId: r.get("drugId") as string,
      drugName: r.get("drugName") as string,
      conditionId: r.get("conditionId") as string,
      conditionName: r.get("conditionName") as string,
      relation: "contraindication" as const,
    }));
  } finally {
    await session.close();
  }
}

// ---------- resolveDrugByName ----------
//
// Lowercased + formulation-stripped exact-match lookup over PrimeKG's
// ~8K drug nodes. The name index is loaded once on first call and cached
// for the lifetime of the process. Hardening target: RxNorm/DrugBank
// crosswalk for real-world salt forms, brand names, and combo arms (see
// spec Risks item 1).

let drugNameIndex: Map<string, KGNode> | null = null;

// Test seam: tests can install a fixture index without touching Neo4j.
export function setDrugNameIndexForTests(idx: Map<string, KGNode> | null): void {
  drugNameIndex = idx;
}

const CYPHER_ALL_DRUGS = `
MATCH (d:Node {type: 'drug'})
RETURN d.id AS id, d.name AS name
` as const;

async function ensureDrugNameIndex(): Promise<Map<string, KGNode>> {
  if (drugNameIndex) return drugNameIndex;
  const session = openSession();
  try {
    const result = await session.run(CYPHER_ALL_DRUGS);
    const idx = new Map<string, KGNode>();
    for (const r of result.records) {
      const id = r.get("id") as string;
      const name = r.get("name") as string;
      idx.set(normalizeDrugName(name), { id, name, type: "drug" });
    }
    drugNameIndex = idx;
    return idx;
  } finally {
    await session.close();
  }
}

// Strip trailing dose/formulation tokens from a free-form intervention
// string. CT.gov interventions look like "Osimertinib 80mg tablet" or
// "Tagrisso 80 mg"; we want them to land on the same key as the
// PrimeKG `name` field. Brittle by design — flagged as a hardening
// target (see spec Risks item 1).
const FORMULATION_TOKENS =
  /\s+\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g|iu|u)\b\s*(?:tablet|tablets|capsule|capsules|injection|injectable|solution|cream|ointment|suspension|syrup|gel|patch|spray|oral|iv|im)?\.?\s*$/i;

function normalizeDrugName(raw: string): string {
  return raw.toLowerCase().replace(FORMULATION_TOKENS, "").trim();
}

export async function resolveDrugByName(name: string): Promise<KGNode | null> {
  const idx = await ensureDrugNameIndex();
  return idx.get(normalizeDrugName(name)) ?? null;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/tools/kg.test.ts
```

Expected: PASS, all existing + 8 new test cases.

### Step 5: Commit

```bash
git add apps/agent/src/tools/kg.ts apps/agent/src/tools/kg.test.ts
git commit -m "Add kg.pathBetween + findContraindicationsForDrugs + resolveDrugByName"
```

---

## Task 4: `prompts/eligibility.ts` — prompt + schema

**Spec ref:** *Node-by-node detail* → `eligibility-check`.

**Files:**
- Modify: `apps/agent/src/prompts/eligibility.ts`
- Create: `apps/agent/src/prompts/eligibility.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/prompts/eligibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ELIGIBILITY_FULL_CHARS,
  EligibilityJudgmentSchema,
  eligibilityPrompt,
} from "./eligibility.js";
import type {
  PatientProfile,
  SafetyConcern,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

function profile(): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 65,
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
    priorTreatments: [],
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
      "Inclusion:\n- Adults 18-75 with T2DM\n- HbA1c > 7\n\nExclusion:\n- Prior insulin therapy",
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
    ...overrides,
  };
}

describe("eligibilityPrompt", () => {
  it("includes patient profile fields", () => {
    const out = eligibilityPrompt(profile(), candidate(), []);
    expect(out).toContain("65");
    expect(out).toContain("female");
    expect(out).toContain("Type 2 diabetes mellitus");
    expect(out).toContain("metformin");
  });

  it("includes the trial's eligibility criteria text", () => {
    const out = eligibilityPrompt(profile(), candidate(), []);
    expect(out).toContain("Adults 18-75");
    expect(out).toContain("Prior insulin therapy");
  });

  it("truncates eligibility text to ELIGIBILITY_FULL_CHARS", () => {
    const long = "x".repeat(ELIGIBILITY_FULL_CHARS + 500);
    const out = eligibilityPrompt(
      profile(),
      candidate({ eligibilityCriteriaText: long }),
      [],
    );
    expect(out).not.toContain(long);
    expect(out).toContain("x".repeat(ELIGIBILITY_FULL_CHARS));
  });

  it("includes safety concerns when present", () => {
    const concern: SafetyConcern = {
      drugId: "DB00072",
      drugName: "trastuzumab",
      conditionId: "MONDO:0005010",
      conditionName: "heart failure",
      relation: "contraindication",
    };
    const out = eligibilityPrompt(profile(), candidate(), [concern]);
    expect(out).toContain("contraindication");
    expect(out).toContain("trastuzumab");
    expect(out).toContain("heart failure");
  });

  it("omits the safety-concerns block when none", () => {
    const out = eligibilityPrompt(profile(), candidate(), []);
    // The block is conditional; no concern entries should appear.
    expect(out).not.toContain("contraindication");
  });
});

describe("EligibilityJudgmentSchema", () => {
  it("accepts a valid assessment", () => {
    const parsed = EligibilityJudgmentSchema.parse({
      inclusion: [{ criterion: "T2DM diagnosis", met: "yes", evidence: "active condition" }],
      exclusion: [{ criterion: "prior insulin", met: "no", evidence: "not in priorTreatments" }],
      overall: "likely_eligible",
    });
    expect(parsed.overall).toBe("likely_eligible");
  });

  it("rejects an unknown overall value", () => {
    expect(() =>
      EligibilityJudgmentSchema.parse({
        inclusion: [],
        exclusion: [],
        overall: "definitely",
      }),
    ).toThrow();
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/prompts/eligibility.test.ts
```

Expected: FAIL — current stub returns `""` and exports no schema.

### Step 3: Implement the prompt + schema

Replace `apps/agent/src/prompts/eligibility.ts` entirely:

```ts
/**
 * # prompts/eligibility
 *
 * Per-criterion analysis of CT.gov's free-form inclusion/exclusion text
 * against the patient profile. Returns a structured `EligibilityAssessment`
 * with per-criterion verdicts (`yes`/`no`/`unknown`) and a coarse 5-level
 * `overall` enum.
 *
 * The prompt also receives the deterministic `SafetyConcern[]` from the
 * KG safety step (computed in `eligibility-check` before this prompt
 * runs). When present, the LLM is told to downgrade `overall` if a
 * concern is clinically relevant — the LLM is the judge of relevance,
 * the structured concerns flow through to `TrialMatch.eligibility.safetyConcerns`
 * regardless.
 *
 * CT.gov eligibility text averages ~1.5KB but the long tail reaches
 * several KB. `ELIGIBILITY_FULL_CHARS = 8000` is the truncation cap:
 * doubles `pre-filter`'s coarse cap (4000) to handle the trial-eval
 * fuller pass, while still bounding token cost.
 */

import { z } from "zod";

import {
  isActiveCondition,
  isActiveMedication,
  type PatientProfile,
  type SafetyConcern,
  type TrialCandidate,
} from "@clinical-trial-matching/shared";

export const ELIGIBILITY_FULL_CHARS = 8000;

export const EligibilityJudgmentSchema = z.object({
  inclusion: z.array(
    z.object({
      criterion: z.string(),
      met: z.enum(["yes", "no", "unknown"]),
      evidence: z.string(),
    }),
  ),
  exclusion: z.array(
    z.object({
      criterion: z.string(),
      met: z.enum(["yes", "no", "unknown"]),
      evidence: z.string(),
    }),
  ),
  overall: z.enum([
    "eligible",
    "likely_eligible",
    "unclear",
    "likely_ineligible",
    "ineligible",
  ]),
});
export type EligibilityJudgment = z.infer<typeof EligibilityJudgmentSchema>;

export function eligibilityPrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  safetyConcerns: SafetyConcern[],
): string {
  const conditions = profile.conditions
    .filter(isActiveCondition)
    .map((c) => `  - ${c.display}`)
    .join("\n");
  const meds = profile.medications
    .filter(isActiveMedication)
    .map((m) => `  - ${m.display}`)
    .join("\n");
  const priorTx = profile.priorTreatments.map((p) => `  - ${p.display}`).join("\n");

  const elig = candidate.eligibilityCriteriaText
    ? candidate.eligibilityCriteriaText.slice(0, ELIGIBILITY_FULL_CHARS)
    : "(none)";

  const safetyBlock =
    safetyConcerns.length > 0
      ? [
          "",
          "PrimeKG safety concerns (deterministic; consider when judging overall):",
          ...safetyConcerns.map(
            (c) =>
              `  - ${c.drugName} has a ${c.relation} edge against the patient's ${c.conditionName}.`,
          ),
        ].join("\n")
      : "";

  return [
    "You are evaluating one clinical trial's eligibility against a patient profile.",
    "Walk the inclusion and exclusion criteria one by one, decide yes/no/unknown",
    "for each against the patient, and cite specific evidence from the profile.",
    "Then assign an overall verdict.",
    "",
    "Patient:",
    `  age: ${profile.ageYears}, sex: ${profile.sex}, deceased: ${profile.deceased}`,
    "  active conditions:",
    conditions || "  (none)",
    "  active medications:",
    meds || "  (none)",
    "  prior treatments:",
    priorTx || "  (none)",
    "",
    "Trial:",
    `  title: ${candidate.title}`,
    `  conditions: ${candidate.conditions.join(", ") || "(none)"}`,
    `  interventions: ${candidate.interventions.join(", ") || "(none)"}`,
    "  eligibility criteria (truncated to first " + ELIGIBILITY_FULL_CHARS + " chars):",
    elig,
    safetyBlock,
    "",
    "Return per-criterion arrays for inclusion and exclusion. For each criterion:",
    "  - criterion: the criterion text (paraphrased; one line)",
    "  - met: yes if the patient satisfies it, no if not, unknown if the profile",
    "    doesn't say. For exclusion criteria, 'yes' means the patient HAS the",
    "    excluded property (i.e., the patient is excluded by it).",
    "  - evidence: a short citation from the profile",
    "",
    "Then assign overall:",
    "  - eligible: all inclusion met, no exclusion triggered",
    "  - likely_eligible: most inclusion met, no major exclusion triggered",
    "  - unclear: insufficient profile data to judge",
    "  - likely_ineligible: one or more important criteria fail",
    "  - ineligible: a hard blocker (excluded subpopulation, missing required prior therapy)",
    "",
    "If a safety concern above is clinically relevant, downgrade overall accordingly.",
  ].join("\n");
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/prompts/eligibility.test.ts
```

Expected: PASS, all 7 cases.

### Step 5: Commit

```bash
git add apps/agent/src/prompts/eligibility.ts apps/agent/src/prompts/eligibility.test.ts
git commit -m "Implement eligibility prompt + EligibilityJudgmentSchema"
```

---

## Task 5: `prompts/mechanism-plausibility.ts` — Path A narrate + Path B score+narrate

**Spec ref:** *Node-by-node detail* → `mechanism-plausibility` (Path A and Path B).

**Files:**
- Modify: `apps/agent/src/prompts/mechanism-plausibility.ts`
- Create: `apps/agent/src/prompts/mechanism-plausibility.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/prompts/mechanism-plausibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  MechanismNarrationSchema,
  MechanismPlausibilityJudgmentSchema,
  mechanismNarratePrompt,
  mechanismScorePrompt,
} from "./mechanism-plausibility.js";
import type {
  KGPath,
  Mechanism,
  PatientProfile,
  RepurposingCandidate,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

function profile(): PatientProfile {
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
  };
}

function trial(): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Osimertinib in EGFR-mutated NSCLC",
    conditions: ["Non-small cell lung carcinoma"],
    interventions: ["Osimertinib"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
  };
}

function mech(): Mechanism {
  return {
    conditionId: "254637007",
    conditionName: "non-small cell lung carcinoma",
    mondoId: "MONDO:0005233",
    geneTargets: [{ id: "EGFR", name: "EGFR", type: "gene_protein" }],
    pathways: [{ id: "GO:0038127", name: "ERBB signaling pathway", type: "biological_process" }],
    supportingPaths: [],
    rationale: "EGFR mutations drive NSCLC.",
  };
}

function kgPath(): KGPath {
  return {
    nodes: [
      { id: "DB09330", name: "osimertinib", type: "drug" },
      { id: "EGFR", name: "EGFR", type: "gene_protein" },
      { id: "MONDO:0005233", name: "non-small cell lung carcinoma", type: "disease" },
    ],
    edges: [
      { source: "DB09330", target: "EGFR", relation: "target" },
      { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
    ],
  };
}

function repurposingCandidate(): RepurposingCandidate {
  return {
    drug: { id: "DB09330", name: "osimertinib", type: "drug" },
    originalIndications: ["non-small cell lung carcinoma"],
    rationale: "TxGNN predicted",
    supportingPaths: [kgPath()],
    predIndication: 0.92,
    predContraindication: 0.05,
  };
}

describe("mechanismScorePrompt (Path B)", () => {
  it("includes trial interventions and patient mechanisms", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()]);
    expect(out).toContain("Osimertinib");
    expect(out).toContain("EGFR");
    expect(out).toContain("ERBB signaling pathway");
  });

  it("includes KG paths in a clearly labeled block", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()]);
    expect(out).toContain("KG path");
    expect(out).toContain("DB09330");
    expect(out).toContain("target");
    expect(out).toContain("associated with");
  });

  it("calls out the no-path case explicitly", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], []);
    expect(out).toMatch(/no kg path/i);
  });
});

describe("mechanismNarratePrompt (Path A)", () => {
  it("includes the TxGNN score and supporting paths from the source candidate", () => {
    const out = mechanismNarratePrompt(profile(), trial(), [mech()], repurposingCandidate());
    expect(out).toContain("0.92");
    expect(out).toContain("osimertinib");
    expect(out).toContain("ERBB signaling pathway");
  });

  it("references the patient's mechanism context", () => {
    const out = mechanismNarratePrompt(profile(), trial(), [mech()], repurposingCandidate());
    expect(out).toContain("EGFR");
  });
});

describe("schemas", () => {
  it("MechanismPlausibilityJudgmentSchema accepts a valid judgment", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 85,
      rationale: "EGFR is targeted by osimertinib...",
    });
    expect(parsed.score).toBe(85);
  });

  it("MechanismPlausibilityJudgmentSchema rejects scores outside 0..100", () => {
    expect(() =>
      MechanismPlausibilityJudgmentSchema.parse({ score: 150, rationale: "x" }),
    ).toThrow();
  });

  it("MechanismNarrationSchema accepts a rationale-only object", () => {
    const parsed = MechanismNarrationSchema.parse({ rationale: "x" });
    expect(parsed.rationale).toBe("x");
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/prompts/mechanism-plausibility.test.ts
```

Expected: FAIL — current stub exports an unused function returning `""`.

### Step 3: Implement the prompts + schemas

Replace `apps/agent/src/prompts/mechanism-plausibility.ts` entirely:

```ts
/**
 * # prompts/mechanism-plausibility
 *
 * Two prompts for the channel-aware `mechanism-plausibility` node:
 *
 *   - Path B (strategy channel): score + narrate. LLM gets KG paths from
 *     `kg.pathBetween` and produces a 0-100 score with rationale.
 *   - Path A (repurposing channel): narrate-only. Score is TxGNN's
 *     `predIndication × 100`; LLM gets the source RepurposingCandidate's
 *     `supportingPaths` (already a KGPath, populated upstream by
 *     `find-repurposing-candidates`) and produces a rationale only.
 *
 * Both prompts share a compact mechanism representation (top genes + top
 * pathways per mechanism) mirroring `prompts/mechanism.ts`.
 */

import { z } from "zod";

import type {
  KGPath,
  Mechanism,
  PatientProfile,
  RepurposingCandidate,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

const GENES_PER_PROMPT = 6;
const PATHWAYS_PER_PROMPT = 6;

export const MechanismPlausibilityJudgmentSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string(),
});
export type MechanismPlausibilityJudgment = z.infer<typeof MechanismPlausibilityJudgmentSchema>;

export const MechanismNarrationSchema = z.object({
  rationale: z.string(),
});
export type MechanismNarration = z.infer<typeof MechanismNarrationSchema>;

// Path B — strategy channel: score + narrate.
export function mechanismScorePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  kgPaths: KGPath[],
): string {
  return [
    "You are scoring the biological plausibility of a clinical trial's",
    "intervention(s) targeting this patient's disease mechanisms.",
    "",
    patientLine(profile),
    "",
    trialBlock(candidate),
    "",
    "Patient mechanisms (gene targets + pathways from PrimeKG):",
    mechanisms.map(formatMechanism).join("\n\n") || "  (none)",
    "",
    kgPaths.length > 0
      ? "Sample KG paths between trial intervention(s) and patient condition(s):"
      : "No KG path found within 3 hops between any (intervention, condition) pair.",
    kgPaths.length > 0 ? kgPaths.map(formatPath).join("\n\n") : "",
    "",
    "Return:",
    "  - score: 0-100 (0 = no plausible mechanism / unrelated; 50 = indirect",
    "    support / weak path; 100 = direct, well-supported by KG path)",
    "  - rationale: 2-3 sentences referencing the specific path or, if no",
    "    path was found, why the score is low.",
  ].join("\n");
}

// Path A — repurposing channel: narrate-only (score is TxGNN-sourced).
export function mechanismNarratePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  source: RepurposingCandidate,
): string {
  const score = (source.predIndication ?? 0).toFixed(2);
  return [
    "TxGNN scored this drug-disease pair at indication probability " + score + ".",
    "Explain that score using the TxGNN explanation path below, in the context",
    "of the patient's disease mechanisms. Do NOT produce a numeric score —",
    "only the rationale.",
    "",
    patientLine(profile),
    "",
    trialBlock(candidate),
    "",
    "Patient mechanisms (gene targets + pathways from PrimeKG):",
    mechanisms.map(formatMechanism).join("\n\n") || "  (none)",
    "",
    "TxGNN explanation path:",
    source.supportingPaths.length > 0
      ? source.supportingPaths.map(formatPath).join("\n\n")
      : "  (no explanation path available)",
    "",
    "Return a 2-3 sentence rationale that names the gene/pathway connecting the",
    "drug to the patient's disease, and references the patient's mechanism context.",
  ].join("\n");
}

function patientLine(p: PatientProfile): string {
  return `Patient: ${p.ageYears}yo ${p.sex}`;
}

function trialBlock(c: TrialCandidate): string {
  return [
    "Trial:",
    `  title: ${c.title}`,
    `  conditions: ${c.conditions.join(", ") || "(none)"}`,
    `  interventions: ${c.interventions.join(", ") || "(none)"}`,
  ].join("\n");
}

function formatMechanism(m: Mechanism): string {
  const genes = m.geneTargets
    .slice(0, GENES_PER_PROMPT)
    .map((g) => g.name)
    .join(", ") || "(none)";
  const pathways = m.pathways
    .slice(0, PATHWAYS_PER_PROMPT)
    .map((p) => p.name)
    .join(", ") || "(none)";
  return [
    `[${m.conditionId}] ${m.conditionName}`,
    `  genes: ${genes}`,
    `  pathways: ${pathways}`,
  ].join("\n");
}

function formatPath(p: KGPath): string {
  // "Osimertinib (DB09330) -[target]- EGFR -[associated with]- non-small cell lung carcinoma (MONDO:0005233)"
  const segments: string[] = [];
  for (let i = 0; i < p.nodes.length; i++) {
    const n = p.nodes[i]!;
    segments.push(`${n.name} (${n.id})`);
    const edge = p.edges[i];
    if (edge) segments.push(`-[${edge.relation}]-`);
  }
  return "  " + segments.join(" ");
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/prompts/mechanism-plausibility.test.ts
```

Expected: PASS, all 8 cases.

### Step 5: Commit

```bash
git add apps/agent/src/prompts/mechanism-plausibility.ts apps/agent/src/prompts/mechanism-plausibility.test.ts
git commit -m "Implement mechanism-plausibility prompts (Path A narrate + Path B score)"
```

---

## Task 6: `prompts/match-narration.ts` — synthesize-match narrate prompt + schema

**Spec ref:** *Node-by-node detail* → `synthesize-match` → Step 2 (LLM narrate).

**Files:**
- Create: `apps/agent/src/prompts/match-narration.ts`
- Create: `apps/agent/src/prompts/match-narration.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/prompts/match-narration.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  MatchNarrationSchema,
  matchNarrationPrompt,
  type MatchNarrationInput,
} from "./match-narration.js";
import type {
  Citation,
  EligibilityAssessment,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

function profile(): PatientProfile {
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
  };
}

function trial(): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Drug X"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
  };
}

function elig(overall: EligibilityAssessment["overall"]): EligibilityAssessment {
  return {
    inclusion: [{ criterion: "T2DM", met: "yes", evidence: "active condition" }],
    exclusion: [],
    overall,
    safetyConcerns: [],
  };
}

function citation(pmid: string, title: string): Citation {
  return { pmid, title, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
}

function input(overrides: Partial<MatchNarrationInput> = {}): MatchNarrationInput {
  return {
    profile: profile(),
    candidate: trial(),
    eligibility: elig("likely_eligible"),
    mechanismScore: 80,
    mechanismRationale: "Drug X targets the patient's GLP-1 pathway.",
    literatureSupport: [citation("123", "GLP-1 in T2DM")],
    sub: { eligibilityScore: 75, mechanismScore: 80, literatureScore: 25, total: 65 },
    discoveredViaRepurposing: false,
    ...overrides,
  };
}

describe("matchNarrationPrompt", () => {
  it("includes all sub-scores and the total", () => {
    const out = matchNarrationPrompt(input());
    expect(out).toContain("75");
    expect(out).toContain("80");
    expect(out).toContain("25");
    expect(out).toContain("65");
  });

  it("includes eligibility overall + first criterion failures", () => {
    const out = matchNarrationPrompt(
      input({
        eligibility: {
          inclusion: [{ criterion: "T2DM", met: "no", evidence: "not in conditions" }],
          exclusion: [],
          overall: "likely_ineligible",
          safetyConcerns: [],
        },
      }),
    );
    expect(out).toContain("likely_ineligible");
    expect(out).toContain("T2DM");
  });

  it("calls out the repurposing discovery channel when applicable", () => {
    const out = matchNarrationPrompt(input({ discoveredViaRepurposing: true }));
    expect(out).toMatch(/repurpos/i);
  });

  it("includes citation titles when present", () => {
    const out = matchNarrationPrompt(input());
    expect(out).toContain("GLP-1 in T2DM");
  });

  it("notes when no citations were found", () => {
    const out = matchNarrationPrompt(input({ literatureSupport: [] }));
    expect(out).toMatch(/no.*citations/i);
  });
});

describe("MatchNarrationSchema", () => {
  it("accepts a valid narration", () => {
    const parsed = MatchNarrationSchema.parse({
      summary: "Drug X is a plausible match.",
      concerns: ["patient is borderline age"],
    });
    expect(parsed.concerns).toHaveLength(1);
  });

  it("accepts empty concerns", () => {
    const parsed = MatchNarrationSchema.parse({ summary: "x", concerns: [] });
    expect(parsed.concerns).toEqual([]);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/prompts/match-narration.test.ts
```

Expected: FAIL — module doesn't exist.

### Step 3: Implement the prompt + schema

Create `apps/agent/src/prompts/match-narration.ts`:

```ts
/**
 * # prompts/match-narration
 *
 * Narration prompt for `synthesize-match`. The LLM does NOT touch the
 * score — that's the deterministic formula's job. The LLM receives the
 * computed score and per-pillar sub-scores, plus the structured signals,
 * and returns a 2-3 sentence `summary` and a structured `concerns` array
 * (red flags worth surfacing).
 */

import { z } from "zod";

import type {
  Citation,
  EligibilityAssessment,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

export const MatchNarrationSchema = z.object({
  summary: z.string(),
  concerns: z.array(z.string()),
});
export type MatchNarration = z.infer<typeof MatchNarrationSchema>;

export type MatchNarrationInput = {
  profile: PatientProfile;
  candidate: TrialCandidate;
  eligibility: EligibilityAssessment;
  mechanismScore: number;
  mechanismRationale: string;
  literatureSupport: Citation[];
  sub: {
    eligibilityScore: number;
    mechanismScore: number;
    literatureScore: number;
    total: number;
  };
  discoveredViaRepurposing: boolean;
};

const MAX_CRITERIA_PREVIEW = 3;
const MAX_CITATION_TITLES = 3;

export function matchNarrationPrompt(input: MatchNarrationInput): string {
  const {
    profile,
    candidate,
    eligibility,
    mechanismScore,
    mechanismRationale,
    literatureSupport,
    sub,
    discoveredViaRepurposing,
  } = input;

  const failedInclusion = eligibility.inclusion
    .filter((c) => c.met === "no")
    .slice(0, MAX_CRITERIA_PREVIEW);
  const triggeredExclusion = eligibility.exclusion
    .filter((c) => c.met === "yes")
    .slice(0, MAX_CRITERIA_PREVIEW);

  const citationTitles = literatureSupport
    .slice(0, MAX_CITATION_TITLES)
    .map((c) => `  - [${c.pmid}] ${c.title}`)
    .join("\n");

  return [
    "Write a brief clinical summary and structured concerns for a trial-patient match.",
    "DO NOT produce a score — it's already computed; you narrate it.",
    "",
    `Patient: ${profile.ageYears}yo ${profile.sex}`,
    "",
    `Trial: ${candidate.title} (${candidate.nctId})`,
    `  conditions: ${candidate.conditions.join(", ") || "(none)"}`,
    `  interventions: ${candidate.interventions.join(", ") || "(none)"}`,
    discoveredViaRepurposing
      ? "  discovery channel: repurposing (TxGNN-predicted intervention for this patient's disease)"
      : "  discovery channel: strategy (mechanism keyword match)",
    "",
    "Sub-scores (deterministic):",
    `  eligibility: ${sub.eligibilityScore}/100`,
    `  mechanism:   ${sub.mechanismScore}/100`,
    `  literature:  ${sub.literatureScore}/100`,
    `  total:       ${sub.total}/100`,
    "",
    `Eligibility verdict: ${eligibility.overall}`,
    failedInclusion.length > 0
      ? "  inclusion criteria the patient does NOT meet:\n" +
        failedInclusion.map((c) => `    - ${c.criterion} (${c.evidence})`).join("\n")
      : "  (no failed inclusion criteria in the prompt window)",
    triggeredExclusion.length > 0
      ? "  exclusion criteria triggered by the patient:\n" +
        triggeredExclusion.map((c) => `    - ${c.criterion} (${c.evidence})`).join("\n")
      : "  (no triggered exclusions in the prompt window)",
    eligibility.safetyConcerns.length > 0
      ? "  safety concerns:\n" +
        eligibility.safetyConcerns
          .map((s) => `    - ${s.relation}: ${s.drugName} vs ${s.conditionName}`)
          .join("\n")
      : "",
    "",
    `Mechanism: ${mechanismScore}/100 — ${mechanismRationale}`,
    "",
    `Literature: ${literatureSupport.length} citation(s)`,
    literatureSupport.length > 0
      ? citationTitles
      : "  (no citations found)",
    "",
    "Return:",
    "  - summary: 2-3 sentences describing the match for a clinician reviewer.",
    "    Reference the sub-scores, the eligibility verdict, and the mechanism",
    "    rationale. Do not repeat the total verbatim.",
    "  - concerns: a list of explicit red flags. Examples: 'patient ineligible',",
    "    'contraindication with X', 'mechanism evaluation unavailable',",
    "    'no PubMed evidence found'. Empty array if no concerns.",
  ].filter((l) => l !== "").join("\n");
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/prompts/match-narration.test.ts
```

Expected: PASS, all 7 cases.

### Step 5: Commit

```bash
git add apps/agent/src/prompts/match-narration.ts apps/agent/src/prompts/match-narration.test.ts
git commit -m "Add match-narration prompt + schema for synthesize-match"
```

---

## Task 7: `nodes/eligibility-check.ts`

**Spec ref:** *Node-by-node detail* → `eligibility-check` (full section).

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../llm.js", () => {
  const invoke = vi.fn();
  return {
    llm: {
      withStructuredOutput: () => ({ invoke }),
    },
    __invoke: invoke,
  };
});

import { eligibilityCheck } from "./eligibility-check.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  PatientProfile,
  SafetyConcern,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as kg from "../../../tools/kg.js";
// @ts-expect-error — vi.mock pseudo-export
import { __invoke } from "../../../llm.js";

afterEach(() => {
  vi.restoreAllMocks();
  __invoke.mockReset();
});

function profile(): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 65,
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
    medications: [],
    labs: [],
    priorTreatments: [],
  };
}

function trial(): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Trastuzumab"],
    status: "RECRUITING",
    locations: [],
    eligibilityCriteriaText: "Adults 18-75 with T2DM",
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
  };
}

function state(): TrialEvalStateType {
  return {
    patientProfile: profile(),
    candidate: trial(),
    mechanisms: [],
    repurposingCandidates: [],
    eligibility: null,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    match: null,
  };
}

describe("eligibilityCheck", () => {
  it("runs the safety check and merges concerns into the assessment", async () => {
    const concern: SafetyConcern = {
      drugId: "DB00072",
      drugName: "trastuzumab",
      conditionId: "MONDO:0005010",
      conditionName: "heart failure",
      relation: "contraindication",
    };
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB00072",
      name: "trastuzumab",
      type: "drug",
    });
    vi.spyOn(kg, "findContraindicationsForDrugs").mockResolvedValue([concern]);
    __invoke.mockResolvedValue({
      inclusion: [{ criterion: "T2DM", met: "yes", evidence: "active condition" }],
      exclusion: [],
      overall: "likely_eligible",
    });
    const out = await eligibilityCheck(state());
    expect(out.eligibility!.safetyConcerns).toEqual([concern]);
    expect(out.eligibility!.overall).toBe("likely_eligible");
  });

  it("falls back to unclear on LLM failure but preserves safetyConcerns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue(null);
    vi.spyOn(kg, "findContraindicationsForDrugs").mockResolvedValue([]);
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await eligibilityCheck(state());
    expect(out.eligibility!.overall).toBe("unclear");
    expect(out.eligibility!.safetyConcerns).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("proceeds with empty safetyConcerns when the Cypher safety call throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB00072",
      name: "trastuzumab",
      type: "drug",
    });
    vi.spyOn(kg, "findContraindicationsForDrugs").mockRejectedValue(new Error("neo4j down"));
    __invoke.mockResolvedValue({
      inclusion: [],
      exclusion: [],
      overall: "unclear",
    });
    const out = await eligibilityCheck(state());
    expect(out.eligibility!.safetyConcerns).toEqual([]);
    expect(out.eligibility!.overall).toBe("unclear");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips unresolvable interventions without erroring", async () => {
    const resolveSpy = vi.spyOn(kg, "resolveDrugByName").mockResolvedValue(null);
    const safetySpy = vi.spyOn(kg, "findContraindicationsForDrugs").mockResolvedValue([]);
    __invoke.mockResolvedValue({
      inclusion: [],
      exclusion: [],
      overall: "unclear",
    });
    await eligibilityCheck(state());
    expect(resolveSpy).toHaveBeenCalled();
    // No interventions resolved → safety call uses empty drugIds → still called or short-circuited;
    // either is acceptable, but the result must be [] either way.
    expect(safetySpy.mock.calls[0]?.[0] ?? []).toEqual([]);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/eligibility-check.test.ts
```

Expected: FAIL — stub returns `{ eligibility: null }`.

### Step 3: Implement the node

Replace `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.ts` entirely:

```ts
/**
 * # eligibility-check (trial-eval subgraph)
 *
 * Two steps:
 *
 *   1. Deterministic safety check: resolve each trial intervention to a
 *      PrimeKG drug node via `kg.resolveDrugByName`; resolve each active
 *      patient condition via the existing SNOMED→MONDO crosswalk; query
 *      Cypher for `(drug)-[:contraindication]-(disease)` edges between
 *      the resolved sets. Produces `SafetyConcern[]`.
 *   2. LLM per-criterion analysis: prompt receives the patient profile,
 *      full eligibility text (truncated to ELIGIBILITY_FULL_CHARS), and
 *      the structured `SafetyConcern[]` so it can downgrade `overall`
 *      when a concern is clinically relevant. Returns
 *      `{ inclusion[], exclusion[], overall }`; the node merges in the
 *      deterministic `safetyConcerns`.
 *
 * Never returns `{error}` — the subgraph contract is to always produce a
 * TrialMatch downstream. LLM failure falls back to `overall: "unclear"`.
 */

import type {
  EligibilityAssessment,
  SafetyConcern,
} from "@clinical-trial-matching/shared";

import { llm } from "../../../llm.js";
import {
  EligibilityJudgmentSchema,
  eligibilityPrompt,
} from "../../../prompts/eligibility.js";
import {
  findContraindicationsForDrugs,
  resolveDrugByName,
} from "../../../tools/kg.js";
import { resolveSnomedCondition } from "../../../tools/snomed-mondo.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const judgeEligibility = llm.withStructuredOutput(EligibilityJudgmentSchema);

export async function eligibilityCheck(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const { patientProfile, candidate } = state;
  const safetyConcerns = await runSafetyStep(
    candidate.interventions,
    patientProfile.conditions
      .filter((c) => !c.clinicalStatus || c.clinicalStatus === "active" ||
        c.clinicalStatus === "recurrence" || c.clinicalStatus === "relapse")
      .map((c) => c.code),
  );

  const judgment = await runLLMStep(state, safetyConcerns);

  const eligibility: EligibilityAssessment = {
    ...judgment,
    safetyConcerns,
  };
  return { eligibility };
}

async function runSafetyStep(
  interventions: string[],
  snomedCodes: string[],
): Promise<SafetyConcern[]> {
  try {
    const drugIds: string[] = [];
    for (const name of interventions) {
      const node = await resolveDrugByName(name);
      if (node) drugIds.push(node.id);
    }
    const diseaseIds: string[] = [];
    for (const code of snomedCodes) {
      const resolved = resolveSnomedCondition(code);
      if (resolved) diseaseIds.push(resolved.primekgNodeId);
    }
    return await findContraindicationsForDrugs(drugIds, diseaseIds);
  } catch (err) {
    console.warn(
      `eligibility-check: safety step failed: ${errorMessage(err)} (continuing with empty concerns)`,
    );
    return [];
  }
}

async function runLLMStep(
  state: TrialEvalStateType,
  safetyConcerns: SafetyConcern[],
): Promise<Omit<EligibilityAssessment, "safetyConcerns">> {
  try {
    const prompt = eligibilityPrompt(state.patientProfile, state.candidate, safetyConcerns);
    return await judgeEligibility.invoke(prompt);
  } catch (err) {
    console.warn(
      `eligibility-check: LLM failed (${state.candidate.nctId}): ${errorMessage(err)} (falling back to unclear)`,
    );
    return { inclusion: [], exclusion: [], overall: "unclear" };
  }
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/eligibility-check.test.ts
```

Expected: PASS, all 4 cases.

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.ts apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.test.ts
git commit -m "Implement eligibility-check: safety Cypher + LLM per-criterion"
```

---

## Task 8: `nodes/mechanism-plausibility.ts` — channel-aware

**Spec ref:** *Node-by-node detail* → `mechanism-plausibility` (full section, Path A + Path B).

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../llm.js", () => {
  const invoke = vi.fn();
  return {
    llm: {
      withStructuredOutput: () => ({ invoke }),
    },
    __invoke: invoke,
  };
});

import { mechanismPlausibility } from "./mechanism-plausibility.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  Mechanism,
  RepurposingCandidate,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as kg from "../../../tools/kg.js";
// @ts-expect-error — vi.mock pseudo-export
import { __invoke } from "../../../llm.js";

afterEach(() => {
  vi.restoreAllMocks();
  __invoke.mockReset();
});

function mech(): Mechanism {
  return {
    conditionId: "254637007",
    conditionName: "non-small cell lung carcinoma",
    mondoId: "MONDO:0005233",
    geneTargets: [{ id: "EGFR", name: "EGFR", type: "gene_protein" }],
    pathways: [{ id: "GO:0038127", name: "ERBB signaling pathway", type: "biological_process" }],
    supportingPaths: [],
    rationale: "",
  };
}

function trial(discoveredVia: ("strategy" | "repurposing")[], repurposingDrugIds: string[] = []): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Osimertinib in NSCLC",
    conditions: ["Non-small cell lung carcinoma"],
    interventions: ["Osimertinib"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: discoveredVia as [typeof discoveredVia[0], ...typeof discoveredVia],
    repurposingDrugIds,
    stdAges: [],
  };
}

function repurposing(drugId: string, predIndication: number, withPath: boolean): RepurposingCandidate {
  return {
    drug: { id: drugId, name: "osimertinib", type: "drug" },
    originalIndications: ["nsclc"],
    rationale: "",
    supportingPaths: withPath
      ? [
          {
            nodes: [
              { id: drugId, name: "osimertinib", type: "drug" },
              { id: "EGFR", name: "EGFR", type: "gene_protein" },
              { id: "MONDO:0005233", name: "nsclc", type: "disease" },
            ],
            edges: [
              { source: drugId, target: "EGFR", relation: "target" },
              { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
            ],
          },
        ]
      : [],
    predIndication,
    predContraindication: 0.05,
  };
}

function state(overrides: Partial<TrialEvalStateType> = {}): TrialEvalStateType {
  return {
    patientProfile: {
      id: "p1",
      displayName: "x",
      ageYears: 60,
      sex: "female",
      deceased: false,
      conditions: [],
      medications: [],
      labs: [],
      priorTreatments: [],
    },
    candidate: trial(["strategy"]),
    mechanisms: [mech()],
    repurposingCandidates: [],
    eligibility: null,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    match: null,
    ...overrides,
  };
}

describe("mechanismPlausibility — Path A (repurposing channel)", () => {
  it("uses TxGNN predIndication × 100 as the score, LLM narrates only", async () => {
    __invoke.mockResolvedValue({ rationale: "EGFR is targeted..." });
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(out.mechanismScore).toBe(92);
    expect(out.mechanismRationale).toContain("EGFR");
  });

  it("falls back to templated rationale when supportingPaths is empty (no LLM call)", async () => {
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.85, false)],
      }),
    );
    expect(out.mechanismScore).toBe(85);
    expect(out.mechanismRationale).toMatch(/explanation path unavailable/i);
    expect(__invoke).not.toHaveBeenCalled();
  });

  it("falls back to templated rationale on LLM failure (Path A)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.88, true)],
      }),
    );
    expect(out.mechanismScore).toBe(88);
    expect(out.mechanismRationale).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("picks the highest predIndication when multiple repurposingDrugIds match", async () => {
    __invoke.mockResolvedValue({ rationale: "x" });
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330", "DB00072"]),
        repurposingCandidates: [
          repurposing("DB09330", 0.92, true),
          { ...repurposing("DB00072", 0.99, true), drug: { id: "DB00072", name: "trastuzumab", type: "drug" } },
        ],
      }),
    );
    expect(out.mechanismScore).toBe(99);
  });
});

describe("mechanismPlausibility — Path B (strategy channel)", () => {
  it("calls kg.pathBetween per (intervention, mechanism) pair and LLM scores", async () => {
    const pathSpy = vi.spyOn(kg, "pathBetween").mockResolvedValue([
      {
        nodes: [{ id: "DB", name: "drug", type: "drug" }],
        edges: [],
      },
    ]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 75, rationale: "Direct path." });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(pathSpy).toHaveBeenCalled();
    expect(out.mechanismScore).toBe(75);
    expect(out.mechanismRationale).toBe("Direct path.");
  });

  it("returns null score + null rationale on LLM failure (Path B)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBeNull();
    expect(out.mechanismRationale).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still runs the LLM step with empty paths if pathBetween returns nothing", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 25, rationale: "No path." });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBe(25);
  });
});

describe("mechanismPlausibility — both channels", () => {
  it("Path A takes precedence when discoveredVia includes 'repurposing'", async () => {
    __invoke.mockResolvedValue({ rationale: "txgnn-narrated" });
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["strategy", "repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(out.mechanismScore).toBe(92);
    expect(out.mechanismRationale).toBe("txgnn-narrated");
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
```

Expected: FAIL — stub returns `{ mechanismScore: null, mechanismRationale: null }`.

### Step 3: Implement the node

Replace `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts` entirely:

```ts
/**
 * # mechanism-plausibility (trial-eval subgraph)
 *
 * Channel-aware scoring of "does the trial's intervention plausibly
 * address the patient's mechanism?"
 *
 *   - Path A (candidate.discoveredVia includes "repurposing"):
 *     score = TxGNN predIndication × 100; LLM narrates rationale from
 *     the source RepurposingCandidate's `supportingPaths`. Templated
 *     fallback when supportingPaths is empty or the LLM fails.
 *
 *   - Path B (strategy-only):
 *     `kg.pathBetween` per (intervention, mechanism) pair; LLM scores
 *     and narrates. Null on LLM failure → synthesize-match maps to 50
 *     with a concern.
 *
 * Spec: docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md
 * → mechanism-plausibility (Path A / Path B).
 */

import type {
  KGPath,
  RepurposingCandidate,
} from "@clinical-trial-matching/shared";

import { llm } from "../../../llm.js";
import {
  MechanismNarrationSchema,
  MechanismPlausibilityJudgmentSchema,
  mechanismNarratePrompt,
  mechanismScorePrompt,
} from "../../../prompts/mechanism-plausibility.js";
import { pathBetween, resolveDrugByName } from "../../../tools/kg.js";
import { resolveSnomedCondition } from "../../../tools/snomed-mondo.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const MAX_KG_PATHS_PER_PROMPT = 6;
const PATHS_PER_PAIR = 3;

const judgeScore = llm.withStructuredOutput(MechanismPlausibilityJudgmentSchema);
const judgeNarrate = llm.withStructuredOutput(MechanismNarrationSchema);

export async function mechanismPlausibility(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const { candidate, repurposingCandidates } = state;
  if (candidate.discoveredVia.includes("repurposing")) {
    return await runPathA(state, repurposingCandidates);
  }
  return await runPathB(state);
}

// ---------- Path A — repurposing channel ----------

async function runPathA(
  state: TrialEvalStateType,
  repurposingCandidates: RepurposingCandidate[],
): Promise<Partial<TrialEvalStateType>> {
  const source = pickSource(state.candidate.repurposingDrugIds, repurposingCandidates);
  if (!source) {
    // Defensive: trial says it came from repurposing but no matching
    // candidate in state. Surface as Path B with no paths.
    console.warn(
      `mechanism-plausibility: candidate ${state.candidate.nctId} claims repurposing channel but no matching RepurposingCandidate found; falling back to Path B`,
    );
    return await runPathB(state);
  }

  const mechanismScore = Math.round((source.predIndication ?? 0) * 100);

  if (source.supportingPaths.length === 0) {
    return {
      mechanismScore,
      mechanismRationale: templatedRationale(source, "explanation path unavailable"),
    };
  }

  try {
    const { rationale } = await judgeNarrate.invoke(
      mechanismNarratePrompt(state.patientProfile, state.candidate, state.mechanisms, source),
    );
    return { mechanismScore, mechanismRationale: rationale };
  } catch (err) {
    console.warn(
      `mechanism-plausibility (Path A): LLM narrate failed for ${state.candidate.nctId}: ${errorMessage(err)} (templated fallback)`,
    );
    return {
      mechanismScore,
      mechanismRationale: templatedRationale(source, "narration unavailable"),
    };
  }
}

function pickSource(
  drugIds: readonly string[],
  candidates: RepurposingCandidate[],
): RepurposingCandidate | undefined {
  const matching = candidates.filter((rc) => drugIds.includes(rc.drug.id));
  if (matching.length === 0) return undefined;
  return matching.reduce((best, c) =>
    (c.predIndication ?? 0) > (best.predIndication ?? 0) ? c : best,
  );
}

function templatedRationale(source: RepurposingCandidate, reason: string): string {
  const score = (source.predIndication ?? 0).toFixed(2);
  const indications = source.originalIndications.join(", ") || "(unknown)";
  return `TxGNN predicted ${source.drug.name} for ${indications} (indication ${score}); ${reason}.`;
}

// ---------- Path B — strategy channel ----------

async function runPathB(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const kgPaths = await collectPaths(state);
  try {
    const { score, rationale } = await judgeScore.invoke(
      mechanismScorePrompt(state.patientProfile, state.candidate, state.mechanisms, kgPaths),
    );
    return { mechanismScore: score, mechanismRationale: rationale };
  } catch (err) {
    console.warn(
      `mechanism-plausibility (Path B): LLM failed for ${state.candidate.nctId}: ${errorMessage(err)} (null score)`,
    );
    return { mechanismScore: null, mechanismRationale: null };
  }
}

async function collectPaths(state: TrialEvalStateType): Promise<KGPath[]> {
  const drugIds: string[] = [];
  for (const name of state.candidate.interventions) {
    try {
      const node = await resolveDrugByName(name);
      if (node) drugIds.push(node.id);
    } catch (err) {
      console.warn(`mechanism-plausibility: resolveDrugByName(${name}) failed: ${errorMessage(err)}`);
    }
  }

  const diseaseIds: string[] = [];
  for (const m of state.mechanisms) {
    const resolved = resolveSnomedCondition(m.conditionId);
    if (resolved) diseaseIds.push(resolved.primekgNodeId);
  }

  if (drugIds.length === 0 || diseaseIds.length === 0) return [];

  const pairs: Array<Promise<KGPath[]>> = [];
  for (const drugId of drugIds) {
    for (const diseaseId of diseaseIds) {
      pairs.push(safePathBetween(drugId, diseaseId));
    }
  }
  const settled = await Promise.all(pairs);
  return roundRobinCap(settled, MAX_KG_PATHS_PER_PROMPT);
}

async function safePathBetween(drugId: string, diseaseId: string): Promise<KGPath[]> {
  try {
    return await pathBetween(drugId, diseaseId, 3, PATHS_PER_PAIR);
  } catch (err) {
    console.warn(`mechanism-plausibility: pathBetween(${drugId}, ${diseaseId}) failed: ${errorMessage(err)}`);
    return [];
  }
}

// Take up to `cap` paths total, drawing in round-robin from each pair's
// returned set. Ensures every (intervention, condition) pair contributes
// at least one path before any pair contributes a second.
function roundRobinCap(pairs: KGPath[][], cap: number): KGPath[] {
  const out: KGPath[] = [];
  let idx = 0;
  while (out.length < cap) {
    let advanced = false;
    for (const pair of pairs) {
      if (idx < pair.length) {
        out.push(pair[idx]!);
        if (out.length >= cap) return out;
        advanced = true;
      }
    }
    if (!advanced) break;
    idx++;
  }
  return out;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
```

Expected: PASS, all 8 cases.

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
git commit -m "Implement mechanism-plausibility: channel-aware Path A + Path B"
```

---

## Task 9: `nodes/literature-support.ts`

**Spec ref:** *Node-by-node detail* → `literature-support`.

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { literatureSupport } from "./literature-support.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  Citation,
  Mechanism,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as pubmed from "../../../tools/pubmed.js";

afterEach(() => vi.restoreAllMocks());

function citation(pmid: string, title = `t${pmid}`): Citation {
  return { pmid, title, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
}

function mech(conditionName: string, pathway?: string): Mechanism {
  return {
    conditionId: "x",
    conditionName,
    mondoId: "MONDO:0005148",
    geneTargets: [],
    pathways: pathway ? [{ id: "p", name: pathway, type: "biological_process" }] : [],
    supportingPaths: [],
    rationale: "",
  };
}

function trial(interventions: string[]): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "x",
    conditions: [],
    interventions,
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
  };
}

function state(overrides: Partial<TrialEvalStateType> = {}): TrialEvalStateType {
  return {
    patientProfile: {
      id: "p1",
      displayName: "x",
      ageYears: 60,
      sex: "female",
      deceased: false,
      conditions: [
        {
          code: "44054006",
          system: "snomed",
          display: "Type 2 diabetes",
          clinicalStatus: "active",
        },
      ],
      medications: [],
      labs: [],
      priorTreatments: [],
    },
    candidate: trial(["metformin"]),
    mechanisms: [mech("type 2 diabetes", "glucose metabolism")],
    repurposingCandidates: [],
    eligibility: null,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    match: null,
    ...overrides,
  };
}

describe("literatureSupport", () => {
  it("attempt 0 query includes drug AND condition AND mechanism keyword", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    await literatureSupport(state());
    expect(spy).toHaveBeenCalledTimes(1);
    const query = spy.mock.calls[0]![0];
    expect(query).toContain("metformin");
    expect(query).toContain("type 2 diabetes");
    expect(query).toContain("glucose metabolism");
  });

  it("attempt 1 (broaden) drops the mechanism keyword", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    await literatureSupport(state({ evidenceAttempts: 1 }));
    const query = spy.mock.calls[0]![0];
    expect(query).toContain("metformin");
    expect(query).toContain("type 2 diabetes");
    expect(query).not.toContain("glucose metabolism");
  });

  it("merges new citations with prior attempt (dedupe by pmid)", async () => {
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([
      citation("A"),
      citation("B"),
      citation("C"),
    ]);
    const out = await literatureSupport(
      state({
        evidenceAttempts: 1,
        literatureSupport: [citation("A"), citation("Z")],
      }),
    );
    const pmids = out.literatureSupport!.map((c) => c.pmid).sort();
    expect(pmids).toEqual(["A", "B", "C", "Z"]);
  });

  it("increments evidenceAttempts on success", async () => {
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([citation("A")]);
    const out = await literatureSupport(state({ evidenceAttempts: 0 }));
    expect(out.evidenceAttempts).toBe(1);
  });

  it("leaves literatureSupport unchanged but bumps attempts on PubMed failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(pubmed, "searchPubMed").mockRejectedValue(new Error("pubmed down"));
    const prior = [citation("A")];
    const out = await literatureSupport(
      state({ evidenceAttempts: 0, literatureSupport: prior }),
    );
    expect(out.literatureSupport).toEqual(prior);
    expect(out.evidenceAttempts).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("caps interventions to 3 in the query", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    await literatureSupport(
      state({ candidate: trial(["a", "b", "c", "d", "e"]) }),
    );
    const q = spy.mock.calls[0]![0];
    expect(q).toContain("a");
    expect(q).toContain("c");
    expect(q).not.toContain("d");
    expect(q).not.toContain("e");
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/literature-support.test.ts
```

Expected: FAIL — stub returns `{ literatureSupport: [], evidenceAttempts: state.evidenceAttempts + 1 }`.

### Step 3: Implement the node

Replace `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts` entirely:

```ts
/**
 * # literature-support (trial-eval subgraph)
 *
 * PubMed citation lookup for a trial-patient match. Two-attempt loop
 * (bounded by `decide-if-more-evidence`): attempt 0 includes the
 * mechanism keyword; attempt 1 drops it (broaden). Citations are merged
 * with prior attempts (dedupe by pmid) so the broaden never reduces the
 * citation set.
 *
 * No LLM call in this node. Pure PubMed retrieval; synthesize-match
 * consumes the citation list.
 */

import type { Citation } from "@clinical-trial-matching/shared";

import { searchPubMed } from "../../../tools/pubmed.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const MAX_INTERVENTIONS_IN_QUERY = 3;
const MAX_RESULTS = 10;

export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const query = buildQuery(state);
  let fetched: Citation[] = [];
  try {
    fetched = await searchPubMed(query, MAX_RESULTS);
  } catch (err) {
    console.warn(
      `literature-support: PubMed failed (${state.candidate.nctId}): ${errorMessage(err)} (keeping prior citations)`,
    );
    return {
      literatureSupport: state.literatureSupport,
      evidenceAttempts: state.evidenceAttempts + 1,
    };
  }

  return {
    literatureSupport: mergeByPmid(state.literatureSupport, fetched),
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}

function buildQuery(state: TrialEvalStateType): string {
  const drugs = state.candidate.interventions
    .slice(0, MAX_INTERVENTIONS_IN_QUERY)
    .map((d) => `"${d}"`)
    .join(" OR ");
  const condition =
    state.mechanisms[0]?.conditionName ??
    state.patientProfile.conditions[0]?.display ??
    "";
  const mechanismKw =
    state.evidenceAttempts === 0
      ? state.mechanisms[0]?.pathways[0]?.name ??
        state.mechanisms[0]?.geneTargets[0]?.name ??
        ""
      : "";

  const parts: string[] = [];
  if (drugs) parts.push(`(${drugs})`);
  if (condition) parts.push(`"${condition}"`);
  if (mechanismKw) parts.push(`"${mechanismKw}"`);
  return parts.join(" AND ");
}

function mergeByPmid(prior: Citation[], fresh: Citation[]): Citation[] {
  const byPmid = new Map<string, Citation>();
  for (const c of prior) byPmid.set(c.pmid, c);
  for (const c of fresh) if (!byPmid.has(c.pmid)) byPmid.set(c.pmid, c);
  return [...byPmid.values()];
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/literature-support.test.ts
```

Expected: PASS, all 6 cases.

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts
git commit -m "Implement literature-support: two-attempt PubMed with broaden + merge"
```

---

## Task 10: `nodes/synthesize-match.ts` — formula + gate + narrate + assemble

**Spec ref:** *Node-by-node detail* → `synthesize-match` (Steps 1–4). *Design decisions* (score-formula row with eligibility gate).

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts`

### Step 1: Write failing tests

Create `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../llm.js", () => {
  const invoke = vi.fn();
  return {
    llm: {
      withStructuredOutput: () => ({ invoke }),
    },
    __invoke: invoke,
  };
});

import { synthesizeMatch } from "./synthesize-match.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  Citation,
  EligibilityAssessment,
  RepurposingCandidate,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

// @ts-expect-error — vi.mock pseudo-export
import { __invoke } from "../../../llm.js";

afterEach(() => __invoke.mockReset());

function trial(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Drug X"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
    ...overrides,
  };
}

function elig(overall: EligibilityAssessment["overall"]): EligibilityAssessment {
  return { inclusion: [], exclusion: [], overall, safetyConcerns: [] };
}

function citation(pmid: string): Citation {
  return { pmid, title: `t${pmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
}

function state(overrides: Partial<TrialEvalStateType> = {}): TrialEvalStateType {
  return {
    patientProfile: {
      id: "p1",
      displayName: "x",
      ageYears: 60,
      sex: "female",
      deceased: false,
      conditions: [],
      medications: [],
      labs: [],
      priorTreatments: [],
    },
    candidate: trial(),
    mechanisms: [],
    repurposingCandidates: [],
    eligibility: elig("likely_eligible"),
    mechanismScore: 80,
    mechanismRationale: "Drug X targets the relevant pathway.",
    literatureSupport: [citation("1"), citation("2"), citation("3")],
    evidenceAttempts: 1,
    match: null,
    ...overrides,
  };
}

describe("synthesizeMatch — score formula", () => {
  it("eligible + mechanism 80 + 3 citations → 89", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({ eligibility: elig("eligible"), mechanismScore: 80 }),
    );
    // 0.5*100 + 0.3*80 + 0.2*75 = 50 + 24 + 15 = 89
    expect(out.match!.score).toBe(89);
  });

  it("likely_ineligible + null mechanism + 0 citations → capped at 25 by gate", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({
        eligibility: elig("likely_ineligible"),
        mechanismScore: null,
        mechanismRationale: null,
        literatureSupport: [],
      }),
    );
    // weightedSum = 0.5*25 + 0.3*50 + 0.2*0 = 27.5 → 28. Gate: min(25, 28) = 25.
    expect(out.match!.score).toBe(25);
  });

  it("ineligible + great biology → 0 (gate)", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: ["patient ineligible"] });
    const out = await synthesizeMatch(
      state({
        eligibility: elig("ineligible"),
        mechanismScore: 90,
        literatureSupport: [citation("a"), citation("b"), citation("c"), citation("d")],
      }),
    );
    expect(out.match!.score).toBe(0);
  });

  it("literature score saturates at 4 citations", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out4 = await synthesizeMatch(
      state({
        literatureSupport: [citation("1"), citation("2"), citation("3"), citation("4")],
      }),
    );
    const out10 = await synthesizeMatch(
      state({
        literatureSupport: Array.from({ length: 10 }, (_, i) => citation(String(i))),
      }),
    );
    expect(out4.match!.score).toBe(out10.match!.score);
  });

  it("null mechanism maps to 50 in the formula", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({ mechanismScore: null, mechanismRationale: null }),
    );
    // eligibility=likely_eligible(75) + mechanism=null→50 + lit=3→75
    // = 0.5*75 + 0.3*50 + 0.2*75 = 37.5 + 15 + 15 = 67.5 → 68
    expect(out.match!.score).toBe(68);
  });
});

describe("synthesizeMatch — repurposingRationale", () => {
  it("populates repurposingRationale for repurposing-channel candidates", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const rc: RepurposingCandidate = {
      drug: { id: "DB09330", name: "osimertinib", type: "drug" },
      originalIndications: ["non-small cell lung carcinoma"],
      rationale: "TxGNN",
      supportingPaths: [],
      predIndication: 0.92,
      predContraindication: 0.05,
    };
    const out = await synthesizeMatch(
      state({
        candidate: trial({ discoveredVia: ["repurposing"], repurposingDrugIds: ["DB09330"] }),
        repurposingCandidates: [rc],
      }),
    );
    expect(out.match!.repurposingRationale).not.toBeNull();
    expect(out.match!.repurposingRationale!.drugName).toBe("osimertinib");
    expect(out.match!.repurposingRationale!.originalIndications).toEqual([
      "non-small cell lung carcinoma",
    ]);
    expect(out.match!.repurposingRationale!.summary).toContain("0.92");
  });

  it("leaves repurposingRationale null for strategy-only candidates", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state());
    expect(out.match!.repurposingRationale).toBeNull();
  });
});

describe("synthesizeMatch — fallback on LLM failure", () => {
  it("computes deterministic score and assembles match even when narrate LLM fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await synthesizeMatch(state());
    expect(out.match).not.toBeNull();
    expect(out.match!.score).toBeGreaterThan(0);
    expect(out.match!.summary).toContain("Drug X for T2DM");
    warn.mockRestore();
  });

  it("includes deterministic concerns when LLM falls back (e.g. ineligible)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockRejectedValue(new Error("x"));
    const out = await synthesizeMatch(state({ eligibility: elig("ineligible") }));
    expect(out.match!.concerns.some((c) => /ineligible/i.test(c))).toBe(true);
  });
});

describe("synthesizeMatch — TrialMatch shape", () => {
  it("carries all TrialCandidate fields onto the match", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state());
    expect(out.match!.nctId).toBe("NCT0001");
    expect(out.match!.title).toBe("Drug X for T2DM");
    expect(out.match!.interventions).toEqual(["Drug X"]);
  });

  it("uses 'Mechanism evaluation unavailable' rationale fallback when state's is null", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state({ mechanismRationale: null }));
    expect(out.match!.mechanismRationale).toMatch(/unavailable/i);
  });
});
```

### Step 2: Run tests to verify they fail

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/synthesize-match.test.ts
```

Expected: FAIL — stub returns `{ match: null }`.

### Step 3: Implement the node

Replace `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts` entirely:

```ts
/**
 * # synthesize-match (trial-eval subgraph)
 *
 * Compose the final `TrialMatch`. Four steps:
 *
 *   1. Deterministic formula computes `score` from the three pillars.
 *      Eligibility-gated: `ineligible → 0`, `likely_ineligible →
 *      min(25, weightedSum)`, otherwise the weighted sum.
 *   2. LLM narrates `summary` + `concerns` given the sub-scores and
 *      structured signals. The LLM does NOT touch the score.
 *   3. Templated `repurposingRationale` when the candidate came from
 *      the repurposing channel.
 *   4. Assemble the TrialMatch from the candidate, the LLM narration,
 *      and the deterministic components.
 *
 * Contract: ALWAYS returns a TrialMatch — the parent's `matches`
 * concat reducer can't distinguish a missing match from a fanned-out
 * miss. Fallback paths handle LLM failure and null mechanism cleanly.
 *
 * Spec: docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md
 * → synthesize-match (Steps 1–4) + score-formula row.
 */

import type {
  RepurposingCandidate,
  RepurposingRationale,
  TrialMatch,
} from "@clinical-trial-matching/shared";

import { llm } from "../../../llm.js";
import {
  MatchNarrationSchema,
  matchNarrationPrompt,
} from "../../../prompts/match-narration.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const WEIGHT_ELIGIBILITY = 0.5;
const WEIGHT_MECHANISM = 0.3;
const WEIGHT_LITERATURE = 0.2;
const LIKELY_INELIGIBLE_CAP = 25;
const LITERATURE_SATURATION = 4; // 4+ citations → 100

const judgeNarration = llm.withStructuredOutput(MatchNarrationSchema);

export async function synthesizeMatch(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const sub = computeSubScores(state);
  const score = gateScore(state.eligibility?.overall, sub.total);

  const repurposingRationale = computeRepurposingRationale(
    state.candidate.repurposingDrugIds,
    state.repurposingCandidates,
  );

  const discoveredViaRepurposing =
    state.candidate.discoveredVia.includes("repurposing");

  let summary: string;
  let concerns: string[];
  try {
    const narration = await judgeNarration.invoke(
      matchNarrationPrompt({
        profile: state.patientProfile,
        candidate: state.candidate,
        eligibility: state.eligibility!,
        mechanismScore: sub.mechanismScore,
        mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
        literatureSupport: state.literatureSupport,
        sub: { ...sub, total: score },
        discoveredViaRepurposing,
      }),
    );
    summary = narration.summary;
    concerns = narration.concerns;
  } catch (err) {
    console.warn(
      `synthesize-match: LLM narrate failed for ${state.candidate.nctId}: ${errorMessage(err)} (templated fallback)`,
    );
    summary = templatedSummary(state, score, sub);
    concerns = deterministicConcerns(state);
  }

  const match: TrialMatch = {
    ...state.candidate,
    score,
    summary,
    eligibility: state.eligibility!,
    mechanismScore: sub.mechanismScore,
    mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
    literatureSupport: state.literatureSupport,
    repurposingRationale,
    concerns,
  };
  return { match };
}

// ---------- Formula ----------

type SubScores = {
  eligibilityScore: number;
  mechanismScore: number;
  literatureScore: number;
  total: number;
};

function computeSubScores(state: TrialEvalStateType): SubScores {
  const eligibilityScore = mapEligibility(state.eligibility?.overall);
  const mechanismScore = state.mechanismScore ?? 50;
  const literatureScore = Math.min(
    100,
    state.literatureSupport.length * (100 / LITERATURE_SATURATION),
  );
  const total = Math.round(
    WEIGHT_ELIGIBILITY * eligibilityScore +
      WEIGHT_MECHANISM * mechanismScore +
      WEIGHT_LITERATURE * literatureScore,
  );
  return { eligibilityScore, mechanismScore, literatureScore, total };
}

function mapEligibility(overall: string | undefined): number {
  switch (overall) {
    case "eligible":
      return 100;
    case "likely_eligible":
      return 75;
    case "unclear":
      return 50;
    case "likely_ineligible":
      return 25;
    case "ineligible":
      return 0;
    default:
      return 50; // null state.eligibility → treat as unclear; defensive
  }
}

function gateScore(overall: string | undefined, weightedSum: number): number {
  if (overall === "ineligible") return 0;
  if (overall === "likely_ineligible") return Math.min(LIKELY_INELIGIBLE_CAP, weightedSum);
  return weightedSum;
}

// ---------- Repurposing rationale ----------

function computeRepurposingRationale(
  drugIds: readonly string[],
  candidates: RepurposingCandidate[],
): RepurposingRationale | null {
  if (drugIds.length === 0) return null;
  const sources = candidates.filter((rc) => drugIds.includes(rc.drug.id));
  if (sources.length === 0) return null;
  const source = sources.reduce((best, c) =>
    (c.predIndication ?? 0) > (best.predIndication ?? 0) ? c : best,
  );
  const score = (source.predIndication ?? 0).toFixed(2);
  const indications = source.originalIndications.join(", ") || "(unknown)";
  return {
    drugName: source.drug.name,
    originalIndications: source.originalIndications,
    summary: `${source.drug.name} is approved for ${indications}; TxGNN predicted it (indication ${score}).`,
  };
}

// ---------- Templated fallbacks ----------

function templatedSummary(
  state: TrialEvalStateType,
  score: number,
  sub: SubScores,
): string {
  const overall = state.eligibility?.overall ?? "unclear";
  return `${state.candidate.title}: eligibility=${overall}, mechanism=${sub.mechanismScore}, ${state.literatureSupport.length} citation(s); composite score ${score}.`;
}

function deterministicConcerns(state: TrialEvalStateType): string[] {
  const concerns: string[] = [];
  const overall = state.eligibility?.overall;
  if (overall === "ineligible") concerns.push("patient ineligible");
  if (overall === "likely_ineligible") concerns.push("patient likely ineligible");
  if (state.eligibility?.safetyConcerns?.length) {
    for (const s of state.eligibility.safetyConcerns) {
      concerns.push(`${s.relation}: ${s.drugName} vs ${s.conditionName}`);
    }
  }
  if (state.mechanismScore == null) concerns.push("mechanism evaluation unavailable");
  if (state.literatureSupport.length === 0) concerns.push("no PubMed evidence found");
  return concerns;
}
```

### Step 4: Run tests to verify they pass

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/synthesize-match.test.ts
```

Expected: PASS, all 10 cases.

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts
git commit -m "Implement synthesize-match: gated formula score + LLM narrate + assemble"
```

---

## Task 11: Update `docs/topology.md`

**Spec ref:** *Implementation order (suggested)* → item 6.

**Files:**
- Modify: `docs/topology.md`

### Step 1: Update the trial-eval subgraph section

Replace the `### Subgraph state` table to add `safetyConcerns` on `eligibility`'s row, and rewrite the `### eligibility-check`, `### mechanism-plausibility`, and `### synthesize-match` sections to reflect:

- `eligibility-check`: now performs a deterministic safety Cypher step (`kg.findContraindicationsForDrugs`) before the LLM call; surfaces `SafetyConcern[]` on the assessment.
- `mechanism-plausibility`: channel-aware. Path A (repurposing) uses TxGNN's `predIndication × 100` and only narrates; Path B (strategy) runs `kg.pathBetween` + LLM scoring.
- `synthesize-match`: score is a deterministic, eligibility-gated weighted sum (`0.5·E + 0.3·M + 0.2·L`, with `ineligible → 0` and `likely_ineligible → min(25, sum)`); LLM narrates `summary` + `concerns` only.

Also update the **Where to look for what** table to add `docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md` as the spec entry for the subgraph.

Exact diff is left to the implementer to keep the topology doc's prose style consistent; the content above is what must be reflected.

### Step 2: Verify the topology doc still typechecks (Markdown only — no compile)

```bash
# Visual review only; no command. Re-read the section against the spec to confirm.
```

### Step 3: Commit

```bash
git add docs/topology.md
git commit -m "Update topology: trial-eval subgraph implemented (channel split + gated score)"
```

---

## Verification — full suite

After all tasks, run the full test suite once to confirm nothing else regressed:

```bash
pnpm -r typecheck
pnpm -r test
```

Expected: all green. No live Neo4j / PubMed / OpenRouter calls in unit tests.

**Manual smoke (optional, not gated):** run `pnpm dev` with Neo4j and `OPENROUTER_API_KEY` set, pick an archetype patient via the web UI, and inspect the resulting `TrialMatch[]`. Look for:

- At least one strategy-only match and one repurposing-channel match.
- `repurposingRationale` populated only on the repurposing-channel match.
- `eligibility.safetyConcerns` non-empty for at least one candidate (try patients/trials with known contraindication edges).
- No `score > 25` on a candidate with `eligibility.overall === "likely_ineligible"` (gate sanity check).
- No `score > 0` on `eligibility.overall === "ineligible"`.

If any of these fails, re-check the relevant node's implementation against the spec before declaring done.
