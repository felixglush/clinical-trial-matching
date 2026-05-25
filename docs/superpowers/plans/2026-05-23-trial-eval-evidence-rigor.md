# Trial-eval evidence rigor (v1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder the trial-eval subgraph so `literature-support` runs before `mechanism-plausibility`, pull PubMed abstracts via EFetch, tier citations by `pubtype`, add a counter-evidence query, and restructure Path B's mechanism prompt to demand quote-cited evidence. The result: `mechanism-plausibility` Path B's score is literature-grounded with adversarial check; `TrialMatch.mechanismEvidence` and `TrialMatch.counterEvidenceAddressed` carry the audit trail.

**Builds on:** v1 implementation (PR #9). v1 must merge first, or this branch must rebase onto v1 after merge.

**Spec:** [`docs/superpowers/specs/2026-05-23-trial-eval-evidence-rigor.md`](../specs/2026-05-23-trial-eval-evidence-rigor.md).

**Tech stack:** unchanged from v1. No new runtime deps.

**Conventions:** `docs/codebase-conventions.md`; CLAUDE.md exact-pinned versions; no `Co-Authored-By` trailer in commits.

---

## File map

**Create:**
- `apps/agent/src/util/pubmed-tiers.ts`
- `apps/agent/src/util/pubmed-tiers.test.ts`
- `apps/agent/src/tools/__fixtures__/pubmed-efetch.txt`
- `apps/agent/src/subgraphs/trial-eval/graph.test.ts`

**Modify:**
- `packages/shared/src/pubmed.ts` — add `Citation.pubtype`.
- `packages/shared/src/trial.ts` — add `MechanismEvidenceItemSchema`, `TrialMatch.mechanismEvidence`, `TrialMatch.counterEvidenceAddressed`.
- `apps/agent/src/subgraphs/trial-eval/state.ts` — add `counterEvidence`, `mechanismEvidence`, `counterEvidenceAddressed` annotations.
- `apps/agent/src/tools/pubmed.ts` — `searchPubMed` populates `pubtype`; new `fetchAbstracts`.
- `apps/agent/src/tools/pubmed.test.ts` — new tests.
- `apps/agent/src/tools/__fixtures__/pubmed-esummary.json` — add `pubtype` arrays.
- `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts` — abstract fetch + counter-evidence query.
- `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts` — new cases.
- `apps/agent/src/prompts/mechanism-plausibility.ts` — restructure Path B prompt, extend schema.
- `apps/agent/src/prompts/mechanism-plausibility.test.ts` — new cases.
- `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts` — Path B consumes literature.
- `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts` — new Path B cases.
- `apps/agent/src/subgraphs/trial-eval/graph.ts` — reorder edges.
- `apps/agent/src/prompts/match-narration.ts` — drop supporting-literature block.
- `apps/agent/src/prompts/match-narration.test.ts` — adjust assertions.
- `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts` — populate `mechanismEvidence` + `counterEvidenceAddressed`; PMID-echo filter.
- `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts` — new cases.
- `docs/topology.md`.

---

## Execution order

Bottom-up, mostly serial. Tasks 1–3 could parallelize but the test-cascade makes serial cleaner.

```
1 schema       2 tiers util       3 pubmed tool
       │            │                   │
       └─────┬──────┴───────┬───────────┘
             ▼              ▼
       4 literature-support (uses 3)
             │
             ▼
       5 mech-plausibility prompt (uses 2)
             │
             ▼
       6 mech-plausibility node (uses 4, 5)
             │
             ▼
       7 subgraph graph reorder
             │
             ▼
       8 synthesize-match (uses 6 outputs, schema)
             │
             ▼
       9 topology doc
```

---

## Task 1: Schema extensions

**Spec ref:** *Schema changes* section.

**Files:**
- Modify: `packages/shared/src/pubmed.ts`
- Modify: `packages/shared/src/trial.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/state.ts`

### Step 1: Extend CitationSchema

`packages/shared/src/pubmed.ts`:

```ts
export const CitationSchema = z.object({
  pmid: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  abstractExcerpt: z.string().optional(),
  pubtype: z.array(z.string()).default([]),   // NEW
  url: z.url(),
});
```

### Step 2: Add MechanismEvidenceItem + extend TrialMatchSchema

`packages/shared/src/trial.ts` — append after the existing `TrialMatchSchema`-relevant types:

```ts
export const MechanismEvidenceItemSchema = z.object({
  pmid: z.string(),
  quote: z.string(),
  supports: z.enum(["yes", "weak", "no"]),
});
export type MechanismEvidenceItem = z.infer<typeof MechanismEvidenceItemSchema>;
```

Then extend `TrialMatchSchema`:

```ts
export const TrialMatchSchema = TrialCandidateSchema.extend({
  // ... existing fields ...
  mechanismEvidence: z.array(MechanismEvidenceItemSchema).default([]),     // NEW
  counterEvidenceAddressed: z.string().nullable().default(null),           // NEW
});
```

### Step 3: Extend subgraph state

`apps/agent/src/subgraphs/trial-eval/state.ts`:

```ts
import type {
  // ... existing imports ...
  MechanismEvidenceItem,
} from "@clinical-trial-matching/shared";

// inside Annotation.Root({...}):

counterEvidence: Annotation<Citation[]>({
  reducer: (_prev, next) => next,
  default: () => [],
}),
mechanismEvidence: Annotation<MechanismEvidenceItem[]>({
  reducer: (_prev, next) => next,
  default: () => [],
}),
counterEvidenceAddressed: Annotation<string | null>({
  reducer: (_prev, next) => next,
  default: () => null,
}),
```

### Step 4: Run typecheck

```bash
pnpm -r typecheck
```

Expected: PASS. New subgraph state fields don't affect the `_AgentStateMatchesGraphState` guard (subgraph state is internal). `TrialMatch` extensions flow through to the parent schema's `matches: TrialMatch[]` naturally via Zod.

### Step 5: Commit

```bash
git add packages/shared/src/pubmed.ts packages/shared/src/trial.ts apps/agent/src/subgraphs/trial-eval/state.ts
git commit -m "Add Citation.pubtype, MechanismEvidence schema, and subgraph state fields for v1.5"
```

---

## Task 2: `util/pubmed-tiers.ts`

**Spec ref:** *Pubtype tiers* table.

**Files:**
- Create: `apps/agent/src/util/pubmed-tiers.ts`
- Create: `apps/agent/src/util/pubmed-tiers.test.ts`

### Step 1: Write failing tests

```ts
import { describe, expect, it } from "vitest";
import { TIER1_PUBTYPES, TIER3_PUBTYPES, tierForCitation, tierLabel } from "./pubmed-tiers.js";

describe("tierForCitation", () => {
  it("returns 1 for RCT / meta-analysis / systematic review", () => {
    expect(tierForCitation({ pubtype: ["Randomized Controlled Trial"] })).toBe(1);
    expect(tierForCitation({ pubtype: ["Meta-Analysis"] })).toBe(1);
    expect(tierForCitation({ pubtype: ["Systematic Review"] })).toBe(1);
  });

  it("returns 3 for case reports / editorials / comments", () => {
    expect(tierForCitation({ pubtype: ["Case Reports"] })).toBe(3);
    expect(tierForCitation({ pubtype: ["Editorial"] })).toBe(3);
    expect(tierForCitation({ pubtype: ["Letter"] })).toBe(3);
  });

  it("defaults to 2 for unknown pubtypes", () => {
    expect(tierForCitation({ pubtype: ["Journal Article"] })).toBe(2);
    expect(tierForCitation({ pubtype: [] })).toBe(2);
    expect(tierForCitation({ pubtype: ["Some Future Pubtype"] })).toBe(2);
  });

  it("returns Tier-1 if ANY pubtype matches Tier-1 (multi-pubtype precedence)", () => {
    expect(tierForCitation({ pubtype: ["Journal Article", "Randomized Controlled Trial"] })).toBe(1);
  });

  it("Tier-1 wins over Tier-3 when both present", () => {
    // Unlikely in real PubMed data but keep the rule strict.
    expect(tierForCitation({ pubtype: ["Editorial", "Meta-Analysis"] })).toBe(1);
  });
});

describe("tierLabel", () => {
  it("returns a human-readable label per tier", () => {
    expect(tierLabel(1)).toMatch(/Tier-1.*RCT/);
    expect(tierLabel(2)).toMatch(/Tier-2/);
    expect(tierLabel(3)).toMatch(/Tier-3.*anecdotal/);
  });
});

describe("constants", () => {
  it("Tier-1 and Tier-3 sets are disjoint", () => {
    for (const t1 of TIER1_PUBTYPES) {
      expect(TIER3_PUBTYPES.has(t1)).toBe(false);
    }
  });
});
```

### Step 2: Verify FAIL

```bash
pnpm --filter agent test -- src/util/pubmed-tiers.test.ts
```

### Step 3: Implement

`apps/agent/src/util/pubmed-tiers.ts` — verbatim from the spec.

### Step 4: Verify PASS

```bash
pnpm --filter agent test -- src/util/pubmed-tiers.test.ts
```

### Step 5: Commit

```bash
git add apps/agent/src/util/pubmed-tiers.ts apps/agent/src/util/pubmed-tiers.test.ts
git commit -m "Add util/pubmed-tiers: deterministic evidence tier mapping"
```

---

## Task 3: `tools/pubmed.ts` — fetchAbstracts + pubtype enrichment

**Spec ref:** *Tool implementations* → both subsections.

**Files:**
- Modify: `apps/agent/src/tools/pubmed.ts`
- Modify: `apps/agent/src/tools/pubmed.test.ts`
- Modify: `apps/agent/src/tools/__fixtures__/pubmed-esummary.json` — add `pubtype` arrays
- Create: `apps/agent/src/tools/__fixtures__/pubmed-efetch.txt`

### Step 1: Update esummary fixture with pubtype

Already present in the existing fixture (per v1 spec). Verify; if any entry is missing `pubtype`, add it.

### Step 2: Create efetch fixture

`apps/agent/src/tools/__fixtures__/pubmed-efetch.txt`:

```
1. N Engl J Med. 2024 Nov 28;391(22):2057-2068. doi: 10.1056/NEJMoa2400000.

Osimertinib versus chemotherapy in EGFR-mutated NSCLC.

Smith J(1), Doe J(2).

Author information:
(1)Department of Oncology, Example Hospital.
(2)Same department.

BACKGROUND: Osimertinib is a third-generation EGFR-TKI that selectively
inhibits both EGFR-TKI sensitizing and EGFR T790M resistance mutations.

METHODS: We conducted a randomized phase III trial comparing osimertinib
with chemotherapy in patients with EGFR-mutated advanced NSCLC.

CONCLUSIONS: Osimertinib showed significantly improved progression-free
survival compared with chemotherapy in EGFR-mutated NSCLC.

PMID: 39603809
DOI: 10.1056/NEJMoa2400000

2. Lancet Oncol. 2024 Oct;25(10):e520-e530.

EGFR T790M resistance mechanisms in NSCLC.

Lee K(1).

Author information:
(1)Translational Cancer Lab.

Background EGFR T790M mutation is the most common resistance mechanism
to first-generation EGFR-TKIs. We review current understanding of T790M
biology and clinical management strategies.

PMID: 39463445
DOI: 10.1016/S1470-2045(24)00000-0
```

(Two records; both ASCII-clean; PMIDs match the esearch/esummary fixtures from v1.)

### Step 3: Write failing tests in `pubmed.test.ts`

Append these test cases (do not remove existing ones):

```ts
import efetchFixture from "./__fixtures__/pubmed-efetch.txt?raw" with { type: "text" };

describe("searchPubMed (pubtype populated)", () => {
  it("populates pubtype from esummary response", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const cits = await searchPubMed("x", 3);
    expect(cits[0]!.pubtype).toEqual(
      expect.arrayContaining(["Journal Article", "Randomized Controlled Trial"]),
    );
    expect(cits[2]!.pubtype).toEqual(["Review"]);  // matches fixture entry #3
  });

  it("defaults pubtype to [] when esummary has none", async () => {
    // Add a fourth fixture entry with no pubtype to the in-test esummary mock.
    const minimalEsummary = JSON.parse(JSON.stringify(esummaryFixture));
    minimalEsummary.result.uids.push("00000001");
    minimalEsummary.result["00000001"] = {
      uid: "00000001",
      pubdate: "2024",
      title: "t",
      articleids: [{ idtype: "pubmed", value: "00000001" }],
    };
    const esearchWithFour = JSON.parse(JSON.stringify(esearchFixture));
    esearchWithFour.esearchresult.idlist.push("00000001");

    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchWithFour))
      .mockResolvedValueOnce(makeResponse(minimalEsummary));
    const cits = await searchPubMed("x", 4);
    const minimal = cits.find((c) => c.pmid === "00000001")!;
    expect(minimal.pubtype).toEqual([]);
  });
});

describe("fetchAbstracts", () => {
  it("parses EFetch text response into a Map keyed by PMID", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(efetchFixture, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const map = await fetchAbstracts(["39603809", "39463445"]);
    expect(map.get("39603809")).toContain("Osimertinib is a third-generation EGFR-TKI");
    expect(map.get("39463445")).toContain("EGFR T790M mutation");
  });

  it("truncates each abstract to 500 chars", async () => {
    const longText = `1. N Engl J Med. 2024.

Long.

Author information:
(1)x

${"x".repeat(2000)}

PMID: 12345678
`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(longText, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const map = await fetchAbstracts(["12345678"]);
    expect(map.get("12345678")!.length).toBeLessThanOrEqual(500);
  });

  it("skips records without an abstract (e.g. editorials)", async () => {
    const noAbs = `1. JAMA. 2024.

Editorial title.

PMID: 87654321
`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(noAbs, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const map = await fetchAbstracts(["87654321"]);
    expect(map.has("87654321")).toBe(false);
  });

  it("returns an empty map for empty pmids input (no network call)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const map = await fetchAbstracts([]);
    expect(map.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries on 503 with backoff (mirrors searchPubMed pattern)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(efetchFixture, { status: 200, headers: { "content-type": "text/plain" } }),
      );
    const promise = fetchAbstracts(["39603809"]);
    await vi.advanceTimersByTimeAsync(1100);
    const map = await promise;
    expect(map.has("39603809")).toBe(true);
  });

  it("appends api_key when PUBMED_API_KEY is set", async () => {
    process.env.PUBMED_API_KEY = "test-key";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(efetchFixture, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await fetchAbstracts(["39603809"]);
    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("api_key")).toBe("test-key");
  });
});
```

### Step 4: Verify FAIL

```bash
pnpm --filter agent test -- src/tools/pubmed.test.ts
```

### Step 5: Implement

In `apps/agent/src/tools/pubmed.ts`:

1. **searchPubMed/esummary**: add `pubtype` to the `EsummaryEntry` type and propagate through `toCitation`:
   ```ts
   type EsummaryEntry = {
     uid?: string;
     title?: string;
     pubdate?: string;
     pubtype?: string[];   // NEW
     articleids?: Array<{ idtype?: string; value?: string }>;
   };

   function toCitation(pmid: string, entry: EsummaryEntry): Citation {
     return {
       pmid,
       title: entry.title ?? "(no title)",
       year: parseYear(entry.pubdate),
       url: `${PUBMED_BASE}/${pmid}/`,
       pubtype: entry.pubtype ?? [],
     };
   }
   ```

2. **`fetchAbstracts`** — new exported function:

   ```ts
   const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
   const ABSTRACT_MAX_CHARS = 500;

   export async function fetchAbstracts(pmids: string[]): Promise<Map<string, string>> {
     if (pmids.length === 0) return new Map();
     const url = appendApiKey(
       `${EFETCH_URL}?db=pubmed&id=${pmids.join(",")}&rettype=abstract&retmode=text`,
     );
     const res = await fetchWithRetry(url);
     if (!res.ok) throw new Error(`PubMed efetch ${res.status} for ${url}`);
     const text = await res.text();
     return parseAbstracts(text);
   }

   // PubMed efetch text format: records separated by blank lines; each record
   // ends with "PMID: <num>". Abstract body is the run of paragraphs between
   // the author information block and the PMID footer. This is a best-effort
   // regex parse — return what we can find; skip records with no abstract.
   function parseAbstracts(text: string): Map<string, string> {
     const map = new Map<string, string>();
     // Split on "PMID: N" lines while preserving them via lookbehind grouping.
     const records = text.split(/\n(?=\d+\. )/);
     for (const rec of records) {
       const pmidMatch = /\nPMID:\s*(\d+)\b/.exec(rec);
       if (!pmidMatch) continue;
       const pmid = pmidMatch[1]!;
       // Heuristic: take everything between the line after "Author information:"
       // ends (an empty line) and the "PMID:" / "Copyright" / "DOI:" footer.
       // Falls back to text between the title and PMID if no author block.
       const lines = rec.split("\n");
       const pmidLineIdx = lines.findIndex((l) => /^PMID:\s*\d+/.test(l));
       if (pmidLineIdx < 0) continue;
       // Find start: after the author/affiliation block. The line immediately
       // after a block of lines starting with "(" or "Author information:" /
       // capitalized name lists. Simplest heuristic: find the first blank line
       // AFTER any line that starts with "(1)" or "Author information:".
       let start = -1;
       let inAuthorBlock = false;
       for (let i = 0; i < pmidLineIdx; i++) {
         const ln = lines[i]!;
         if (/^Author information:/.test(ln)) inAuthorBlock = true;
         if (inAuthorBlock && ln.trim() === "") {
           start = i + 1;
           break;
         }
       }
       if (start < 0) continue; // no author block → no reliable abstract boundary
       // End at the PMID line, also stopping at Copyright/DOI/©.
       let end = pmidLineIdx;
       for (let i = start; i < pmidLineIdx; i++) {
         const ln = lines[i]!;
         if (/^(Copyright|©|DOI:)/i.test(ln)) {
           end = i;
           break;
         }
       }
       const abstract = lines.slice(start, end).join("\n").trim();
       if (!abstract) continue;
       map.set(pmid, abstract.slice(0, ABSTRACT_MAX_CHARS));
     }
     return map;
   }
   ```

### Step 6: Verify PASS

```bash
pnpm --filter agent test -- src/tools/pubmed.test.ts
```

### Step 7: Commit

```bash
git add apps/agent/src/tools/pubmed.ts apps/agent/src/tools/pubmed.test.ts apps/agent/src/tools/__fixtures__/pubmed-esummary.json apps/agent/src/tools/__fixtures__/pubmed-efetch.txt
git commit -m "Add pubmed.fetchAbstracts (EFetch text mode); populate Citation.pubtype from esummary"
```

---

## Task 4: `literature-support` — abstracts + counter-evidence

**Spec ref:** *Architecture (subgraph delta)* → `literature-support` box.

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts`

### Step 1: New test cases

Append to `literature-support.test.ts`:

```ts
describe("literatureSupport — abstracts + pubtype", () => {
  it("calls fetchAbstracts for the supporting-query results and merges into citations", async () => {
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([
      { pmid: "A", title: "tA", url: "u", pubtype: ["Review"] },
      { pmid: "B", title: "tB", url: "u", pubtype: [] },
    ]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(
      new Map([["A", "Abstract for A."]]),
    );
    const out = await literatureSupport(state());
    const a = out.literatureSupport!.find((c) => c.pmid === "A")!;
    const b = out.literatureSupport!.find((c) => c.pmid === "B")!;
    expect(a.abstractExcerpt).toBe("Abstract for A.");
    expect(b.abstractExcerpt).toBeUndefined();
  });

  it("soft-fails when fetchAbstracts throws (citations keep abstractExcerpt undefined)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([
      { pmid: "A", title: "tA", url: "u", pubtype: [] },
    ]);
    vi.spyOn(pubmed, "fetchAbstracts").mockRejectedValue(new Error("EFetch down"));
    const out = await literatureSupport(state());
    expect(out.literatureSupport![0]!.abstractExcerpt).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("literatureSupport — counter-evidence", () => {
  it("issues a second PubMed query with counter-evidence terms ANDed", async () => {
    const searchSpy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    await literatureSupport(state());
    expect(searchSpy).toHaveBeenCalledTimes(2);
    const counterQuery = searchSpy.mock.calls[1]![0];
    expect(counterQuery).toMatch(/metformin/);
    expect(counterQuery).toMatch(/type 2 diabetes/);
    expect(counterQuery).toMatch(/failed|discontinued|futility|toxicity|negative|withdrawn|no benefit/);
  });

  it("writes counter-evidence to state.counterEvidence (separate from literatureSupport)", async () => {
    const supportingHits = [{ pmid: "S1", title: "supporting", url: "u", pubtype: [] }];
    const counterHits = [{ pmid: "C1", title: "failed trial", url: "u", pubtype: [] }];
    vi.spyOn(pubmed, "searchPubMed").mockImplementation(async (q) =>
      /failed|discontinued|futility|toxicity|negative|withdrawn|no benefit/.test(q)
        ? counterHits
        : supportingHits,
    );
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    const out = await literatureSupport(state());
    expect(out.literatureSupport!.map((c) => c.pmid)).toEqual(["S1"]);
    expect(out.counterEvidence!.map((c) => c.pmid)).toEqual(["C1"]);
  });

  it("does NOT run a second counter-evidence query on attempt 1 (broaden only applies to supporting)", async () => {
    const searchSpy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    await literatureSupport(state({ evidenceAttempts: 1 }));
    expect(searchSpy).toHaveBeenCalledTimes(1);  // supporting only on broaden
  });

  it("soft-fails when counter-evidence query throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(pubmed, "searchPubMed").mockImplementation(async (q) =>
      /failed|discontinued/.test(q)
        ? Promise.reject(new Error("PubMed down"))
        : [],
    );
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    const out = await literatureSupport(state());
    expect(out.counterEvidence).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

### Step 2: Verify FAIL

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/literature-support.test.ts
```

### Step 3: Implement

Replace `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`:

```ts
import type { Citation } from "@clinical-trial-matching/shared";
import { fetchAbstracts, searchPubMed } from "../../../tools/pubmed.js";
import type { TrialEvalStateType } from "../state.js";
import { errorMessage } from "../../../util/error.js";

const MAX_INTERVENTIONS_IN_QUERY = 3;
const SUPPORTING_MAX_RESULTS = 10;
const COUNTER_MAX_RESULTS = 5;

const COUNTER_TERMS = [
  "failed",
  "no benefit",
  "discontinued",
  "futility",
  "toxicity",
  "negative",
  "withdrawn",
] as const;

export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const supportingQuery = buildSupportingQuery(state);
  const counterQuery =
    state.evidenceAttempts === 0 ? buildCounterQuery(state) : null;

  // Supporting search (always); counter-evidence search only on first attempt.
  const tasks: Array<Promise<Citation[] | null>> = [
    safeSearch(supportingQuery, SUPPORTING_MAX_RESULTS, "supporting"),
  ];
  if (counterQuery) {
    tasks.push(safeSearch(counterQuery, COUNTER_MAX_RESULTS, "counter"));
  }
  const [supportingResult, counterResult] = await Promise.all(tasks);

  let supporting = supportingResult ?? state.literatureSupport;
  if (supportingResult) {
    supporting = await enrichWithAbstracts(supportingResult);
    supporting = mergeByPmid(state.literatureSupport, supporting);
  }

  let counterEvidence: Citation[] = state.counterEvidence ?? [];
  if (counterResult) {
    counterEvidence = await enrichWithAbstracts(counterResult);
  }

  return {
    literatureSupport: supporting,
    counterEvidence,
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}

async function safeSearch(
  query: string,
  max: number,
  label: string,
): Promise<Citation[] | null> {
  try {
    return await searchPubMed(query, max);
  } catch (err) {
    console.warn(
      `literature-support (${label}): searchPubMed failed: ${errorMessage(err)}`,
    );
    return null;
  }
}

async function enrichWithAbstracts(cits: Citation[]): Promise<Citation[]> {
  if (cits.length === 0) return cits;
  try {
    const abstractMap = await fetchAbstracts(cits.map((c) => c.pmid));
    return cits.map((c) => {
      const abs = abstractMap.get(c.pmid);
      return abs ? { ...c, abstractExcerpt: abs } : c;
    });
  } catch (err) {
    console.warn(`literature-support: fetchAbstracts failed: ${errorMessage(err)}`);
    return cits;
  }
}

function buildSupportingQuery(state: TrialEvalStateType): string {
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

function buildCounterQuery(state: TrialEvalStateType): string {
  const drugs = state.candidate.interventions
    .slice(0, MAX_INTERVENTIONS_IN_QUERY)
    .map((d) => `"${d}"`)
    .join(" OR ");
  const condition =
    state.mechanisms[0]?.conditionName ??
    state.patientProfile.conditions[0]?.display ??
    "";
  const counterOR = COUNTER_TERMS.map((t) => `"${t}"`).join(" OR ");
  const parts: string[] = [];
  if (drugs) parts.push(`(${drugs})`);
  if (condition) parts.push(`"${condition}"`);
  parts.push(`(${counterOR})`);
  return parts.join(" AND ");
}

function mergeByPmid(prior: Citation[], fresh: Citation[]): Citation[] {
  const byPmid = new Map<string, Citation>();
  for (const c of prior) byPmid.set(c.pmid, c);
  for (const c of fresh) if (!byPmid.has(c.pmid)) byPmid.set(c.pmid, c);
  return [...byPmid.values()];
}
```

### Step 4: Verify PASS

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/literature-support.test.ts
```

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts apps/agent/src/subgraphs/trial-eval/nodes/literature-support.test.ts
git commit -m "literature-support: pull abstracts; add counter-evidence query (no cycle)"
```

---

## Task 5: `mechanism-plausibility` prompt restructure

**Spec ref:** *Mechanism-plausibility Path B prompt (v1.5)*.

**Files:**
- Modify: `apps/agent/src/prompts/mechanism-plausibility.ts`
- Modify: `apps/agent/src/prompts/mechanism-plausibility.test.ts`

### Step 1: Extend the test cases

Existing tests still cover `mechanismScorePrompt`'s shape; add new cases for the literature block, tier ordering, counter-evidence block, and the extended schema:

```ts
import type { Citation } from "@clinical-trial-matching/shared";

function tier1Citation(): Citation {
  return {
    pmid: "A1",
    title: "RCT supporting evidence",
    url: "u",
    pubtype: ["Randomized Controlled Trial"],
    abstractExcerpt: "RCT showed osimertinib superior to chemotherapy in EGFR-mutated NSCLC.",
  };
}
function tier2Citation(): Citation {
  return {
    pmid: "B1",
    title: "Cohort study",
    url: "u",
    pubtype: ["Cohort Studies"],
    abstractExcerpt: "Observational cohort confirms benefit.",
  };
}
function tier3Citation(): Citation {
  return {
    pmid: "C1",
    title: "Case report on rare resistance",
    url: "u",
    pubtype: ["Case Reports"],
    abstractExcerpt: "(should NOT appear in prompt for Tier-3 since we hide abstracts)",
  };
}
function counterCitation(): Citation {
  return {
    pmid: "X1",
    title: "Phase III trial discontinued for futility",
    url: "u",
    pubtype: ["Randomized Controlled Trial"],
    abstractExcerpt: "Trial halted due to futility at interim analysis.",
  };
}

describe("mechanismScorePrompt (v1.5) — literature blocks", () => {
  it("groups supporting literature into Tier-1, Tier-2, Tier-3 blocks", () => {
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation(), tier2Citation(), tier3Citation()],
      [],
    );
    expect(out).toContain("Tier-1");
    expect(out).toContain("Tier-2");
    expect(out).toContain("Tier-3");
    // Tier-1 should appear before Tier-2 in the output.
    expect(out.indexOf("Tier-1")).toBeLessThan(out.indexOf("Tier-2"));
    expect(out.indexOf("Tier-2")).toBeLessThan(out.indexOf("Tier-3"));
  });

  it("shows abstracts for Tier-1 and Tier-2 but not Tier-3", () => {
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation(), tier3Citation()],
      [],
    );
    expect(out).toContain("RCT showed osimertinib");      // Tier-1 abstract shown
    expect(out).not.toContain("should NOT appear");         // Tier-3 abstract hidden
  });

  it("conditionally renders the counter-evidence block only when non-empty", () => {
    const without = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation()],
      [],
    );
    expect(without).toContain("No counter-evidence retrieved");

    const withCounter = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation()],
      [counterCitation()],
    );
    expect(withCounter).toContain("halted due to futility");
    expect(withCounter).toContain("X1");
  });

  it("instructs LLM to weight Tier-1 > Tier-2 > Tier-3 and address counter-evidence", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], []);
    expect(out).toMatch(/Tier-1.*Tier-2.*Tier-3/s);
    expect(out).toMatch(/counterEvidenceAddressed/);
  });
});

describe("MechanismPlausibilityJudgmentSchema (v1.5)", () => {
  it("accepts score + rationale + evidence + counterEvidenceAddressed", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 80,
      rationale: "Strong Tier-1 evidence supports the mechanism.",
      evidence: [
        { pmid: "A1", quote: "RCT showed superior PFS.", supports: "yes" },
        { pmid: "X1", quote: "Trial halted for futility.", supports: "no" },
      ],
      counterEvidenceAddressed: "Counter-evidence trial used different patient population.",
    });
    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.counterEvidenceAddressed).toBeTruthy();
  });

  it("accepts empty evidence array", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 50, rationale: "no quotable evidence", evidence: [],
    });
    expect(parsed.evidence).toEqual([]);
  });

  it("rejects invalid 'supports' enum value", () => {
    expect(() =>
      MechanismPlausibilityJudgmentSchema.parse({
        score: 50, rationale: "x",
        evidence: [{ pmid: "A1", quote: "q", supports: "maybe" }],
      }),
    ).toThrow();
  });
});
```

### Step 2: Verify FAIL

```bash
pnpm --filter agent test -- src/prompts/mechanism-plausibility.test.ts
```

### Step 3: Implement

`apps/agent/src/prompts/mechanism-plausibility.ts` — full replacement, key changes:

```ts
import { z } from "zod";
import type {
  Citation,
  KGPath,
  Mechanism,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";
import { tierForCitation, tierLabel, type EvidenceTier } from "../util/pubmed-tiers.js";

// ... existing constants ...
const TIER1_TIER2_ABSTRACT_HIDE = false;
const TIER3_ABSTRACT_HIDE = true;

export const MechanismPlausibilityJudgmentSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string(),
  evidence: z.array(
    z.object({
      pmid: z.string(),
      quote: z.string(),
      supports: z.enum(["yes", "weak", "no"]),
    }),
  ),
  counterEvidenceAddressed: z.string().optional(),
});
export type MechanismPlausibilityJudgment = z.infer<typeof MechanismPlausibilityJudgmentSchema>;

// Signature changes: now takes supporting + counter citations.
export function mechanismScorePrompt(
  profile: PatientProfile,
  candidate: TrialCandidate,
  mechanisms: Mechanism[],
  kgPaths: KGPath[],
  supporting: Citation[],
  counter: Citation[],
): string {
  const grouped = groupByTier(supporting);
  const literatureBlock = [
    `${tierLabel(1)}:`,
    formatTier(grouped[1], { showAbstract: true }),
    "",
    `${tierLabel(2)}:`,
    formatTier(grouped[2], { showAbstract: true }),
    "",
    `${tierLabel(3)}:`,
    formatTier(grouped[3], { showAbstract: false }),
  ].join("\n");

  const counterBlock =
    counter.length > 0
      ? counter.map((c) => formatCitation(c, { showAbstract: true })).join("\n\n")
      : "  No counter-evidence retrieved.";

  return [
    "You are scoring the biological plausibility of a clinical trial's",
    "intervention(s) targeting this patient's disease mechanisms. Use both",
    "KG paths AND published literature as evidence. Higher-tier literature",
    "outweighs lower-tier (Tier-1 > Tier-2 > Tier-3).",
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
    "Supporting literature (grouped by evidence tier):",
    literatureBlock,
    "",
    "Counter-evidence (papers describing failure / futility / toxicity / withdrawal):",
    counterBlock,
    "",
    "Return:",
    "  - score: 0-100. Weight Tier-1 strongly; Tier-2 moderately; Tier-3 lightly.",
    "    KG-only support without literature: cap at ~55. Strong Tier-1 support:",
    "    can reach 100. Strong counter-evidence: significantly reduce score.",
    "  - rationale: 2-3 sentences combining KG path + literature into a",
    "    biological argument.",
    "  - evidence: 2-4 entries. Each must:",
    "      - pmid: a PMID actually present above (do NOT invent)",
    "      - quote: short verbatim excerpt from that paper's abstract (≤200 chars)",
    "      - supports: 'yes' / 'weak' / 'no'",
    "    Include at least one counter-evidence quote (supports: 'no') if any",
    "    counter-evidence is present.",
    "  - counterEvidenceAddressed: if counter-evidence is present, one sentence",
    "    on whether/how it changes the score. Omit if no counter-evidence.",
  ].join("\n");
}

function groupByTier(cits: Citation[]): Record<EvidenceTier, Citation[]> {
  const out: Record<EvidenceTier, Citation[]> = { 1: [], 2: [], 3: [] };
  for (const c of cits) {
    out[tierForCitation(c)].push(c);
  }
  return out;
}

function formatTier(cits: Citation[], opts: { showAbstract: boolean }): string {
  if (cits.length === 0) return "  (none)";
  return cits.map((c) => formatCitation(c, opts)).join("\n\n");
}

function formatCitation(c: Citation, opts: { showAbstract: boolean }): string {
  const lines = [
    `  [${c.pmid}] ${c.title}`,
    `  Pubtype: ${c.pubtype.join(", ") || "(none)"}`,
  ];
  if (opts.showAbstract) {
    lines.push(`  Abstract excerpt: ${c.abstractExcerpt ?? "(unavailable)"}`);
  }
  return lines.join("\n");
}

// ... patientLine, trialBlock, formatMechanism, formatPath unchanged ...
```

### Step 4: Verify PASS

```bash
pnpm --filter agent test -- src/prompts/mechanism-plausibility.test.ts
```

### Step 5: Commit

```bash
git add apps/agent/src/prompts/mechanism-plausibility.ts apps/agent/src/prompts/mechanism-plausibility.test.ts
git commit -m "mechanism-plausibility prompt: literature-grounded with tier groups + counter-evidence + cited evidence schema"
```

---

## Task 6: `mechanism-plausibility` node — consume literature

**Spec ref:** *Architecture (subgraph delta)* → mechanism-plausibility Path B box.

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`

### Step 1: Extend tests

Add Path B cases for literature + counter-evidence + evidence output:

```ts
describe("mechanismPlausibility — Path B literature integration (v1.5)", () => {
  it("passes literatureSupport and counterEvidence into mechanismScorePrompt", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB", name: "drug", type: "drug",
    });
    __invoke.mockResolvedValue({
      score: 70,
      rationale: "tier-1 supports",
      evidence: [{ pmid: "A1", quote: "supports", supports: "yes" }],
    });
    const out = await mechanismPlausibility(state({
      literatureSupport: [{ pmid: "A1", title: "t", url: "u", pubtype: ["Randomized Controlled Trial"], abstractExcerpt: "abs" }],
      counterEvidence: [],
    }));
    expect(out.mechanismScore).toBe(70);
    expect(out.mechanismRationale).toBe("tier-1 supports");
    expect(out.mechanismEvidence).toEqual([
      { pmid: "A1", quote: "supports", supports: "yes" },
    ]);
  });

  it("writes counterEvidenceAddressed when LLM provides it", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB", name: "drug", type: "drug",
    });
    __invoke.mockResolvedValue({
      score: 40,
      rationale: "weak overall",
      evidence: [{ pmid: "X1", quote: "futility", supports: "no" }],
      counterEvidenceAddressed: "Different population than this patient.",
    });
    const out = await mechanismPlausibility(state({
      counterEvidence: [{ pmid: "X1", title: "t", url: "u", pubtype: [] }],
    }));
    expect(out.counterEvidenceAddressed).toBe("Different population than this patient.");
  });

  it("Path A is unchanged — no mechanismEvidence written for repurposing channel", async () => {
    const out = await mechanismPlausibility(state({
      candidate: trial(["repurposing"], ["DB09330"]),
      repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      literatureSupport: [{ pmid: "X", title: "t", url: "u", pubtype: [] }],
    }));
    expect(out.mechanismScore).toBe(92);
    expect(out.mechanismEvidence).toBeUndefined();   // not written by Path A
    expect(__invoke).not.toHaveBeenCalled();          // still LLM-free
  });
});
```

### Step 2: Verify FAIL

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
```

### Step 3: Implement

Update `mechanism-plausibility.ts`:

- `runPathB` now reads `state.literatureSupport` and `state.counterEvidence`; passes them into `mechanismScorePrompt`.
- LLM returns the v1.5 schema; node writes `mechanismScore`, `mechanismRationale`, `mechanismEvidence`, `counterEvidenceAddressed` to state.
- Path A unchanged.

Key delta:

```ts
async function runPathB(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  const kgPaths = await collectPaths(state);
  try {
    const judgment = await judgeScore.invoke(
      mechanismScorePrompt(
        state.patientProfile,
        state.candidate,
        state.mechanisms,
        kgPaths,
        state.literatureSupport,
        state.counterEvidence,
      ),
    );
    return {
      mechanismScore: judgment.score,
      mechanismRationale: judgment.rationale,
      mechanismEvidence: judgment.evidence,
      counterEvidenceAddressed: judgment.counterEvidenceAddressed ?? null,
    };
  } catch (err) {
    console.warn(
      `mechanism-plausibility (Path B): LLM failed for ${state.candidate.nctId}: ${errorMessage(err)} (null score)`,
    );
    return {
      mechanismScore: null,
      mechanismRationale: null,
      mechanismEvidence: [],
      counterEvidenceAddressed: null,
    };
  }
}
```

Path A returns the same fields as before (no `mechanismEvidence` write — defaults to `[]` via state annotation).

### Step 4: Verify PASS

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
```

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts
git commit -m "mechanism-plausibility node: Path B consumes literature, writes evidence + counterEvidenceAddressed"
```

---

## Task 7: Subgraph edge reorder + graph wiring test

**Spec ref:** *Architecture (subgraph delta)*.

**Files:**
- Modify: `apps/agent/src/subgraphs/trial-eval/graph.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/graph.test.ts`

### Step 1: Write the wiring test first

```ts
import { describe, expect, it } from "vitest";
import { trialEvalGraph } from "./graph.js";

describe("trial-eval subgraph wiring", () => {
  it("includes the 5 expected nodes and the cycle", () => {
    // Compiled graph exposes nodes via toString() / getGraph(); use whichever
    // surface LangGraph 1.3.2 provides. Falls back to checking the compiled
    // graph's node map directly.
    const graph = trialEvalGraph.getGraph();
    const nodeNames = graph.nodes.map((n: { id: string }) => n.id).sort();
    expect(nodeNames).toEqual([
      "__start__",
      "__end__",
      "eligibility-check",
      "literature-support",
      "mechanism-plausibility",
      "synthesize-match",
    ].sort());
  });

  it("orders edges: start → eligibility-check → literature-support → mechanism-plausibility → synthesize-match → end", () => {
    const graph = trialEvalGraph.getGraph();
    const edges = graph.edges.map((e: { source: string; target: string }) =>
      `${e.source}→${e.target}`,
    );
    expect(edges).toContain("__start__→eligibility-check");
    expect(edges).toContain("eligibility-check→literature-support");
    // mechanism-plausibility comes AFTER literature-support (the v1.5 reorder).
    expect(edges).toContain("mechanism-plausibility→synthesize-match");
    expect(edges).toContain("synthesize-match→__end__");
    // The decide-if-more-evidence cycle still points back to literature-support.
    expect(edges.filter((e) => e === "literature-support→mechanism-plausibility")).toHaveLength(1);
  });
});
```

(If `getGraph()` shape differs in LangGraph 1.3.2, adjust the test to whatever surface introspection the library provides. Worst case: assert via end-to-end execution with mocks.)

### Step 2: Verify FAIL

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/graph.test.ts
```

### Step 3: Reorder edges

Update `apps/agent/src/subgraphs/trial-eval/graph.ts`:

```ts
import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState } from "./state.js";
import { eligibilityCheck } from "./nodes/eligibility-check.js";
import { mechanismPlausibility } from "./nodes/mechanism-plausibility.js";
import { literatureSupport } from "./nodes/literature-support.js";
import { decideIfMoreEvidence } from "./nodes/decide-if-more-evidence.js";
import { synthesizeMatch } from "./nodes/synthesize-match.js";

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("eligibility-check", eligibilityCheck)
  .addNode("literature-support", literatureSupport)
  .addNode("mechanism-plausibility", mechanismPlausibility)
  .addNode("synthesize-match", synthesizeMatch)
  .addEdge(START, "eligibility-check")
  .addEdge("eligibility-check", "literature-support")
  .addConditionalEdges("literature-support", decideIfMoreEvidence, [
    "literature-support",
    "mechanism-plausibility",
  ])
  .addEdge("mechanism-plausibility", "synthesize-match")
  .addEdge("synthesize-match", END)
  .compile();
```

(`decideIfMoreEvidence` returns `"literature-support"` for the cycle or `"mechanism-plausibility"` for proceed. Update the routing function's return type if needed.)

Update `decide-if-more-evidence.ts`:

```ts
export function decideIfMoreEvidence(
  state: TrialEvalStateType,
): "literature-support" | "mechanism-plausibility" {
  const needMore =
    state.literatureSupport.length < MIN_CITATIONS &&
    state.evidenceAttempts < MAX_EVIDENCE_ATTEMPTS;
  return needMore ? "literature-support" : "mechanism-plausibility";
}
```

### Step 4: Verify PASS

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/graph.test.ts
pnpm -r typecheck
pnpm -r test
```

### Step 5: Commit

```bash
git add apps/agent/src/subgraphs/trial-eval/graph.ts apps/agent/src/subgraphs/trial-eval/nodes/decide-if-more-evidence.ts apps/agent/src/subgraphs/trial-eval/graph.test.ts
git commit -m "Reorder trial-eval subgraph: literature-support before mechanism-plausibility"
```

---

## Task 8: `synthesize-match` — drop citations block, populate evidence

**Spec ref:** *Synthesize-match changes*.

**Files:**
- Modify: `apps/agent/src/prompts/match-narration.ts`
- Modify: `apps/agent/src/prompts/match-narration.test.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts`
- Modify: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts`

### Step 1: Prompt — drop citations block

In `match-narration.ts`, remove the "Supporting literature" block from the prompt body (the LLM still gets the citation count for context but not titles or excerpts). Update the test that asserted "includes citation titles when present" to instead assert "summary references the mechanism evidence" (or remove if not directly verifiable).

### Step 2: Node — populate mechanismEvidence + counterEvidenceAddressed; PMID-echo filter

In `synthesizeMatch`, after assembling the LLM narration:

```ts
const knownPmids = new Set([
  ...state.literatureSupport.map((c) => c.pmid),
  ...state.counterEvidence.map((c) => c.pmid),
]);
const filteredEvidence = state.mechanismEvidence.filter((e) => {
  const ok = knownPmids.has(e.pmid);
  if (!ok) {
    console.warn(
      `synthesize-match: dropping mechanismEvidence with unknown pmid=${e.pmid} (not in literatureSupport or counterEvidence)`,
    );
  }
  return ok;
});

// Concerns: counter-evidence present but unaddressed
if (state.counterEvidence.length > 0 && !state.counterEvidenceAddressed) {
  concerns.push("counter-evidence present but not addressed in mechanism judgment");
}
// Concerns: no literature-cited evidence
if (filteredEvidence.length === 0 && state.mechanismScore !== null) {
  concerns.push("no literature-cited evidence for mechanism");
}

const match: TrialMatch = {
  ...state.candidate,
  // ... existing fields ...
  mechanismEvidence: filteredEvidence,
  counterEvidenceAddressed: state.counterEvidenceAddressed,
};
```

### Step 3: New synthesize-match test cases

```ts
describe("synthesizeMatch — mechanismEvidence and counterEvidenceAddressed", () => {
  it("propagates mechanismEvidence onto the TrialMatch", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state({
      mechanismEvidence: [{ pmid: "A1", quote: "q", supports: "yes" }],
      literatureSupport: [{ pmid: "A1", title: "t", url: "u", pubtype: [] }],
    }));
    expect(out.matches![0]!.mechanismEvidence).toEqual([
      { pmid: "A1", quote: "q", supports: "yes" },
    ]);
  });

  it("filters out evidence entries whose pmid is not in literatureSupport ∪ counterEvidence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state({
      mechanismEvidence: [
        { pmid: "A1", quote: "q", supports: "yes" },
        { pmid: "INVENTED", quote: "fake", supports: "yes" },
      ],
      literatureSupport: [{ pmid: "A1", title: "t", url: "u", pubtype: [] }],
    }));
    expect(out.matches![0]!.mechanismEvidence.map((e) => e.pmid)).toEqual(["A1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flags 'counter-evidence present but unaddressed' concern", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state({
      counterEvidence: [{ pmid: "X1", title: "t", url: "u", pubtype: [] }],
      counterEvidenceAddressed: null,
    }));
    expect(out.matches![0]!.concerns).toContain(
      "counter-evidence present but not addressed in mechanism judgment",
    );
  });

  it("propagates counterEvidenceAddressed onto the TrialMatch", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state({
      counterEvidence: [{ pmid: "X1", title: "t", url: "u", pubtype: [] }],
      counterEvidenceAddressed: "Population differs.",
    }));
    expect(out.matches![0]!.counterEvidenceAddressed).toBe("Population differs.");
  });
});
```

### Step 4: Verify

```bash
pnpm --filter agent test -- src/subgraphs/trial-eval/nodes/synthesize-match.test.ts
pnpm --filter agent test -- src/prompts/match-narration.test.ts
```

### Step 5: Commit

```bash
git add apps/agent/src/prompts/match-narration.ts apps/agent/src/prompts/match-narration.test.ts apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.test.ts
git commit -m "synthesize-match: drop citations block; populate mechanismEvidence with PMID-echo filter"
```

---

## Task 9: Topology doc

**Files:** Modify `docs/topology.md`.

Update:
- Subgraph state table — add `counterEvidence`, `mechanismEvidence`, `counterEvidenceAddressed` rows.
- `### literature-support` — document the new abstract fetch and counter-evidence pass.
- `### mechanism-plausibility` Path B — document the literature-grounded prompt + evidence schema + PMID-echo filter.
- `### synthesize-match` — note the citations block was dropped from narrate prompt.
- Edge order — update to `eligibility-check → literature-support ⇄ mechanism-plausibility → synthesize-match`.
- **Where to look for what** — add the v1.5 spec entry.

Commit:
```bash
git add docs/topology.md
git commit -m "Topology: v1.5 literature-grounded mechanism judgment"
```

---

## Verification

After all 9 tasks:

```bash
pnpm -r typecheck
pnpm -r test
pnpm --filter web test:e2e   # existing suite still passes
```

**Live e2e smoke** via `playwright-cli`:
1. Kick off a fresh match for Hedy Sauer.
2. Poll the LangGraph thread until `interrupted`.
3. Inspect each match for:
   - `literatureSupport[*].abstractExcerpt` populated for most entries (some preprints/editorials have no abstract → undefined is OK)
   - `literatureSupport[*].pubtype` populated
   - `counterEvidence` array non-empty for at least one match (tamoxifen has plenty of negative-result lit)
   - `mechanismEvidence` non-empty for Path B matches; all PMIDs present in `literatureSupport ∪ counterEvidence`
   - `counterEvidenceAddressed` set when `counterEvidence` is non-empty
   - Path A matches still have empty `mechanismEvidence` and `counterEvidenceAddressed: null`
4. No `console.warn` floods about `dropping mechanismEvidence with unknown pmid=...` (low rate is acceptable; high rate signals prompt issue).
