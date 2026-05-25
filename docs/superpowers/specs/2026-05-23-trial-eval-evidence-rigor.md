# Trial-eval evidence rigor (v1.5): literature-grounded mechanism judgment

**Date:** 2026-05-23
**Status:** Draft v1 (pending user review)
**Builds on:** [`2026-05-23-trial-eval-subgraph-design.md`](./2026-05-23-trial-eval-subgraph-design.md) (v1, shipping in PR #9). v1.5 is a *follow-up* — does not block v1 from merging.

## Scope (in)

1. **Reorder subgraph.** `literature-support` runs *before* `mechanism-plausibility` (was after). The decide-if-more-evidence cycle moves with it.
2. **Pull abstracts via EFetch.** New `tools/pubmed.ts::fetchAbstracts(pmids)` text-mode call; populates `Citation.abstractExcerpt` (already in the schema, currently always `undefined`).
3. **Pubtype tiering.** `searchPubMed` populates a new `Citation.pubtype: string[]` from esummary. Prompt formatter groups citations into Tier-1 (RCT / meta-analysis / systematic review) / Tier-2 (clinical trial / cohort / review) / Tier-3 (case report / editorial / comment).
4. **Counter-evidence query.** A second PubMed pass in `literature-support` searches for adversarial signals (`failed`, `discontinued`, `futility`, `toxicity`, etc.); results land on a new `state.counterEvidence: Citation[]`. Single attempt, no broaden cycle (this is a signal pass, not a coverage pass).
5. **Evidence-cited rationale.** `MechanismPlausibilityJudgmentSchema` gains `evidence: Array<{pmid, quote, supports}>` and `counterEvidenceAddressed: string.optional()`. The LLM must defend its score with quoted abstract excerpts; if counter-evidence is present, it must address it. Both surface on the final `TrialMatch`.

## Scope (out)

- **Path A.** TxGNN-sourced score + templated rationale unchanged. No LLM, no literature. Repurposing channel's evidence is already in the TxGNN data.
- **Score formula.** Still `round(0.6·E + 0.4·M)` with the eligibility gate. Literature still not a score input — it's an evidence input to mechanism judgment.
- iCite / DisGeNET / OpenTargets integration (deferred).
- Per-KG-edge decomposed scoring (deferred).
- Citation-network / co-citation analysis (deferred).
- Recency / journal-impact weighting beyond pubtype tiers (deferred).

## Goal

Move `mechanism-plausibility` Path B from **"structural KG path presence + LLM read"** to **"literature-grounded biological judgment with adversarial check."** The LLM scoring this trial's biology now sees:

1. KG paths (the structural skeleton — unchanged).
2. Top-K supporting PubMed papers with abstracts, tier-grouped.
3. Top-K counter-evidence papers if any matched.

…and must return a score *plus* 2–4 quoted abstract excerpts justifying the call, *plus* a sentence on how counter-evidence was weighed.

This makes the project's signature step — "mechanism-aware matching" — judge on the same evidence type a clinician would use: peer-reviewed literature, not just topological connections in PrimeKG.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Subgraph order | `eligibility-check → literature-support ⇄ decide-if-more-evidence → mechanism-plausibility → synthesize-match` | Mechanism needs literature as input; literature-support has no dependency on mechanism-plausibility (its query keywords come from upstream `state.mechanisms`). |
| Abstract retrieval | New `fetchAbstracts(pmids)` in `tools/pubmed.ts` via EFetch text mode (`rettype=abstract&retmode=text`). Called by `literature-support` after esearch+esummary, batched in one call per attempt. | EFetch text mode is the cheapest abstract source (no XML parsing); plain text is regex-parseable; one batch call per attempt keeps PubMed budget bounded. |
| Abstract cap | Truncate to first 500 chars per abstract in the prompt | Most abstracts state the conclusion / mechanism claim in the first ~300 chars. 500 chars × 5 abstracts ≈ 2.5KB prompt addition. |
| `Citation.pubtype` | New field, populated from esummary's `pubtype: string[]` (already present in the response, currently unused) | Zero extra API cost; lets us tier without a separate call. |
| Pubtype tiering | Three deterministic tiers computed client-side in the prompt formatter. LLM sees both tier label and raw pubtype array. | Reproducible ranking; LLM still has flexibility if it spots something interesting in the raw types. Tiers documented as a single source of truth (see *Pubtype tiers* table below). |
| Counter-evidence query | Single PubMed call inside `literature-support` with query `(<drug1> OR <drug2>) AND <condition> AND (<counter terms ORed>)` | Targeted adversarial search. Single attempt (no broaden) because this is signal: hit count is irrelevant; presence is the signal. |
| Counter-evidence cap | Top-5 by esearch ranking | Bounds prompt size; PubMed's relevance ranking surfaces strongest hits first. |
| Counter-evidence terms | `failed`, `no benefit`, `discontinued`, `futility`, `toxicity`, `negative`, `withdrawn` (constant, named) | Conservative list — high-precision negative-result vocabulary. Tune after first runs if false positives dominate. |
| Evidence on TrialMatch | New `TrialMatch.mechanismEvidence: Array<{pmid, quote, supports: "yes"\|"weak"\|"no"}>` + `TrialMatch.counterEvidenceAddressed: string \| null` | Clinician audit surface. Each evidence entry must reference a PMID actually in `literatureSupport` or `counterEvidence` (validated soft — warn-log on PMID drift, don't block). |
| Mechanism schema update | `MechanismPlausibilityJudgmentSchema` extends with `evidence[]` and `counterEvidenceAddressed?` | Forces the LLM to defend the score. Bedrock-route caveat: do not add `.min(N)` / `.max(N)` on the evidence array; cap is enforced via prompt instruction ("Return 2–4 entries") + post-LLM slice if needed. |
| Path A (repurposing channel) | **Unchanged.** Score = `TxGNN predIndication × 100`; templated rationale from supportingPaths. No LLM call. | TxGNN already encodes literature signal (the model was trained on it). Re-doing it via PubMed adds latency without value. `mechanismEvidence` is `[]` for Path A. |
| `synthesize-match` narrate prompt | DROP the "supporting literature" block (mechanism rationale now references citations and quotes evidence). Keep `literatureSupport` on the TrialMatch for the clinician brief. | Avoids the narrate LLM redundantly listing citations that the mechanism rationale already cited. |
| Prompt size budget (Path B) | KG paths (≤6 × ~150 chars) + supporting abstracts (≤5 × 500 chars) + counter-evidence (≤5 × 500 chars) + boilerplate ≈ 5–6KB | Well under Haiku's effective context window; comparable to existing `eligibility-check` prompt size. |
| PMID echo validation | Soft: `synthesize-match` filters `mechanismEvidence` to entries whose PMID appears in `state.literatureSupport ∪ state.counterEvidence`; warn-logs dropped entries | LLM occasionally invents PMIDs. Filtering server-side keeps the TrialMatch audit-clean without blocking the run. |
| Subgraph state shape | Adds `counterEvidence`, `mechanismEvidence`, `counterEvidenceAddressed`. The bridge-rename fix (matches: TrialMatch[]) from v1 is unchanged. | New fields use replace reducers; no fan-out concerns inside the subgraph. |
| Concurrency | Path B's literature reads add 0 LLM calls but +1 PubMed call (counter-evidence) and +1 PubMed call (efetch abstracts per attempt) per subgraph. Peak total: ~4 PubMed / subgraph × 5 fan-out = 20 PubMed calls per run. | With `PUBMED_API_KEY` (10 req/sec), comfortably within budget. Without key (3 req/sec), still acceptable since the calls serialize within a subgraph. |

## Pubtype tiers

Single source of truth — both the formatter and the prompt instruction reference this:

| Tier | PubMed `pubtype` values (any match) | Prompt label |
|---|---|---|
| 1 | `Randomized Controlled Trial`, `Meta-Analysis`, `Systematic Review` | Tier-1: strongest evidence (RCT / meta-analysis) |
| 2 | `Clinical Trial`, `Clinical Trial, Phase III`, `Clinical Trial, Phase II`, `Cohort Studies`, `Review`, `Multicenter Study` | Tier-2: clinical / review evidence |
| 3 | `Case Reports`, `Editorial`, `Comment`, `Letter`, `News`, `Personal Narrative` | Tier-3: anecdotal / opinion |
| (default) | anything not in the above | Tier-2 (lenient: better to under-promote than miss something) |

The tier list lives once in `apps/agent/src/util/pubmed-tiers.ts` (new file); the formatter and the schema both import from it.

## Architecture (subgraph delta vs v1)

```
                  START
                    │
                    ▼
          eligibility-check                 (unchanged)
                    │
                    ▼
          ┌─────────────────────┐ ◀── (cycle from below)
          │ literature-support  │
          │  v1.5 ENHANCED:     │
          │  1. esearch +       │
          │     esummary        │
          │  2. fetchAbstracts  │  → Citation[] w/ abstract + pubtype
          │  3. counter-evidence│  → state.counterEvidence
          │     pass (no cycle) │
          │  4. broaden-on-     │
          │     retry — apply   │
          │     to supporting   │
          │     query only      │
          └─────────────────────┘
                    │
                    ▼
        decide-if-more-evidence              (unchanged: cycles supporting only)
                    │
                    ▼
          ┌─────────────────────┐
          │ mechanism-          │
          │ plausibility        │
          │                     │
          │  Path A: unchanged  │ → mechanismEvidence: []
          │  (TxGNN, no LLM)    │
          │                     │
          │  Path B v1.5:       │
          │   1. KG pathBetween │
          │   2. Prompt:        │
          │      KG paths +     │
          │      tier-grouped   │
          │      lit w/         │
          │      abstracts +    │
          │      counter-evid   │
          │   3. LLM returns    │
          │      score +        │
          │      rationale +    │
          │      evidence[] +   │
          │      counterAddressd│
          │   4. Validate PMIDs │
          │      against state  │
          │      (soft, warn)   │
          └─────────────────────┘
                    │
                    ▼
          ┌─────────────────────┐
          │ synthesize-match    │
          │  v1.5: drop the     │
          │  citations block    │
          │  from narrate       │
          │  prompt; surface    │
          │  mechanismEvidence  │
          │  on TrialMatch      │
          └─────────────────────┘
                    │
                    ▼
                   END
```

## Tool implementations

### `tools/pubmed.ts::fetchAbstracts(pmids: string[]): Promise<Map<string, string>>`

```text
GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi
    ?db=pubmed&id=<comma-sep-pmids>&rettype=abstract&retmode=text[&api_key=<key>]
```

Response is plain text, one citation per record, separated by `\n\n`. Parse with a small state machine:

- Split on `^PMID: (\d+)` line — the trailing PMID identifies the record above it.
- Within each record, the abstract is the block between (a) the empty line after the author/affiliation block and (b) the line starting with `Author information:` or `PMID:`/`Copyright`/`DOI:`.
- Some records have no abstract (preprints, editorials) — skip silently.
- Return `Map<pmid, abstractText>`; truncate each to 500 chars before storing.

Retry on 429/503 same as existing helpers; honors `Retry-After`. PUBMED_API_KEY adds `&api_key=...` to the URL.

### `tools/pubmed.ts::searchPubMed` (modified)

esummary's response already includes `pubtype: string[]` per uid. Pull it through:

```ts
function toCitation(pmid: string, entry: EsummaryEntry): Citation {
  return {
    pmid,
    title: entry.title ?? "(no title)",
    year: parseYear(entry.pubdate),
    url: `${PUBMED_BASE}/${pmid}/`,
    pubtype: entry.pubtype ?? [],   // NEW
  };
}
```

No new API call; pure response-mapping change.

### `apps/agent/src/util/pubmed-tiers.ts` (new)

```ts
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
```

Imported by the mechanism-plausibility prompt formatter.

## Schema changes

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

`packages/shared/src/trial.ts`:

```ts
export const MechanismEvidenceItemSchema = z.object({
  pmid: z.string(),
  quote: z.string(),
  supports: z.enum(["yes", "weak", "no"]),
});
export type MechanismEvidenceItem = z.infer<typeof MechanismEvidenceItemSchema>;

// TrialMatchSchema gains two optional fields:
mechanismEvidence: z.array(MechanismEvidenceItemSchema).default([]),
counterEvidenceAddressed: z.string().nullable().default(null),
```

`apps/agent/src/subgraphs/trial-eval/state.ts`:

```ts
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

The compile-time `_AgentStateMatchesGraphState` guard at the bottom of `apps/agent/src/state.ts` does NOT need updates because these are *subgraph* state — they aren't part of the parent-graph contract. (The TrialMatch carries them out via `mechanismEvidence` and `counterEvidenceAddressed` fields, which DO show up in the parent because TrialMatch ends up in `state.matches`.)

## Mechanism-plausibility Path B prompt (v1.5)

```
You are scoring the biological plausibility of a clinical trial's intervention(s)
targeting this patient's disease mechanisms. Use both KG paths AND published
literature as evidence. Higher-tier literature outweighs lower-tier.

Patient: <age>yo <sex>

Trial:
  title: <title>
  conditions: <conditions>
  interventions: <interventions>

Patient mechanisms:
  [<conditionId>] <conditionName>
    genes: <top 6 gene names>
    pathways: <top 6 pathway names>

KG evidence (paths from PrimeKG):
  <path 1>: drug (id) -[rel]- node (id) -[rel]- node (id) -[rel]- disease (id)
  <path 2>: ...
  ...
  (or: "No KG path found within 3 hops between any (intervention, condition) pair.")

Tier-1 literature (RCT / meta-analysis / systematic review):
  [<pmid>] <title>
  Pubtype: <pubtype joined>
  Abstract excerpt: <first 500 chars>

  [<pmid>] ...
  ...

Tier-2 literature (clinical / review evidence):
  ...

Tier-3 literature (anecdotal / opinion):
  [<pmid>] <title>   (no abstract shown for Tier-3)

Counter-evidence (papers describing failure, futility, toxicity, or
discontinuation for this drug-condition pair):
  [<pmid>] <title>
  Pubtype: ...
  Abstract excerpt: ...

  (Or, if state.counterEvidence is empty: "No counter-evidence retrieved.")

Return:
  - score: 0–100. Weight Tier-1 strongly; Tier-2 moderately; Tier-3 lightly.
    KG-only support without literature: cap at ~55. Strong Tier-1 support without
    KG: still high. Strong counter-evidence: significantly reduce score even if
    supporting evidence exists.
  - rationale: 2-3 sentences combining KG path + literature into a biological argument.
  - evidence: 2-4 entries. Each must:
      - pmid: a PMID actually present above (do not invent)
      - quote: short excerpt from that paper's abstract (verbatim, ≤200 chars)
      - supports: "yes" if the quote supports plausibility, "weak" if it partially
        supports / mixed signals, "no" if it refutes
    Include at least one counter-evidence quote (supports: "no") if any counter-
    evidence was present.
  - counterEvidenceAddressed: if counter-evidence was present, one sentence on
    whether/how it changes the score. Empty string if no counter-evidence.
```

Schema:

```ts
export const MechanismPlausibilityJudgmentSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string(),
  evidence: z.array(z.object({
    pmid: z.string(),
    quote: z.string(),
    supports: z.enum(["yes", "weak", "no"]),
  })),
  counterEvidenceAddressed: z.string().optional(),
});
```

(No `.min`/`.max` on `evidence` — Bedrock route. Cap is in the prompt + post-LLM slice if >6.)

## Synthesize-match changes

Two small changes:

1. **Drop the supporting literature block from the narrate prompt.** Mechanism rationale now references citations; the narrate LLM doesn't need to also list them.
2. **Populate `match.mechanismEvidence` and `match.counterEvidenceAddressed`** from subgraph state. Apply the PMID-echo filter: drop any evidence entry whose `pmid` is not in `state.literatureSupport ∪ state.counterEvidence`; warn-log the drift.

`TrialMatch.literatureSupport` continues to carry the full Citation[] for the clinician brief.

## Error model

| Failure | Handling |
|---|---|
| `fetchAbstracts` throws | All citations keep `abstractExcerpt: undefined`; prompt formatter notes "(abstract unavailable)" per entry; subgraph proceeds |
| Counter-evidence PubMed call throws | `state.counterEvidence = []`; prompt notes "Counter-evidence search unavailable"; subgraph proceeds |
| `mechanism-plausibility` LLM produces empty `evidence: []` | Allowed; LLM probably had nothing solid; `synthesize-match` adds concern "no literature-cited evidence for mechanism" |
| LLM cites a PMID not in state | Filtered out in `synthesize-match`; warn-log the drift; the surviving evidence still surfaces |
| Counter-evidence present but `counterEvidenceAddressed` is null/empty | `synthesize-match` adds concern "counter-evidence present but unaddressed" |
| Path A unchanged failure modes | (See v1 spec) |

## Testing

- **`tools/pubmed.test.ts`**: add `fetchAbstracts` tests with a new `__fixtures__/pubmed-efetch.txt` fixture; verify parsing extracts the right abstract per PMID; verify 429/503 retry on EFetch; pubtype field in esummary fixture + assertion.
- **`util/pubmed-tiers.test.ts`** (new): tier mapping for all canonical pubtype values; defaults to Tier-2; multi-pubtype handled.
- **`prompts/mechanism-plausibility.test.ts`** (extend): assert literature blocks appear in prompt; tier ordering deterministic; counter-evidence block conditional; abstract truncation visible; evidence schema accepts/rejects.
- **`nodes/literature-support.test.ts`** (extend): counter-evidence query construction (drug + condition + counter terms); fetchAbstracts merged into Citation[]; counterEvidence written to state; supporting-query broaden cycle unchanged.
- **`nodes/mechanism-plausibility.test.ts`** (extend Path B): receives literature; evidence array flows to state; counterEvidenceAddressed set when counterEvidence present; PMID validation happens downstream (in synthesize-match, not here).
- **`nodes/synthesize-match.test.ts`** (extend): mechanismEvidence on TrialMatch; PMID-echo filter drops invented PMIDs; concern flagged when counterEvidence present but unaddressed.
- **`subgraphs/trial-eval/graph.test.ts`** (new): assert edge order is `eligibility-check → literature-support → mechanism-plausibility → synthesize-match`.

No live PubMed / Neo4j / LLM in unit tests. Integration smoke (manual): run a Hedy Sauer match; verify `mechanismEvidence` arrays surface on the TrialMatch with real PMIDs from `literatureSupport`; verify at least one match has a `counterEvidenceAddressed` entry (Hedy's tamoxifen has a body of negative-result lit).

## Risks and open items

1. **EFetch parsing is regex-based.** PubMed's text format is stable but not formally specified; edge cases (papers with structured abstracts: BACKGROUND/METHODS/RESULTS) need handling. Mitigation: cap at 500 chars per record, fall back to undefined on parse failure. Tighten if first runs show frequent parse drops.
2. **LLM PMID invention.** The evidence schema requires PMIDs, but the LLM might cite PMIDs not in the supplied set. `synthesize-match`'s echo filter catches this; surviving evidence is still useful. Watch the warn-log frequency.
3. **Counter-evidence term list is heuristic.** "Failed" / "discontinued" co-occur in trial-history papers that describe SUCCESSFUL discontinuation of prior agents (irrelevant). Tune list after first runs; consider adding a Boolean-NOT for "subsequent line" / "after progression".
4. **Pubtype tiers are coarse.** A "Review" can be a Cochrane-level systematic review (Tier-1 worthy) or a low-rigor narrative review (Tier-2). PubMed's pubtype doesn't distinguish; we'd need a journal-quality lookup to refine. Acceptable for v1.5.
5. **Latency budget.** Adding fetchAbstracts (1 call) + counter-evidence search+summary (2 calls) per subgraph. Peak: ~4 PubMed calls / subgraph × 5 fan-out = 20 calls. At 10 req/s with API key, ~2 seconds added serially; at 3 req/s without, ~7 seconds. Acceptable; flag for monitoring.
6. **Bedrock structured-output route.** As in v1, do not add `.min`/`.max` on the `evidence` array — Bedrock rejects `maxItems`. Cap in prompt + post-process.

## Implementation order

1. **Schema** — `Citation.pubtype`, `MechanismEvidenceItem`, `TrialMatch.mechanismEvidence` + `counterEvidenceAddressed`, subgraph state additions.
2. **`util/pubmed-tiers.ts`** + co-located tests.
3. **`tools/pubmed.ts`** — `fetchAbstracts` + `searchPubMed` populates `pubtype`; new EFetch fixture.
4. **`literature-support` node** — abstract fetch + counter-evidence query; broaden cycle still applies to supporting only.
5. **`mechanism-plausibility` prompt + node** — new prompt with literature blocks; schema with `evidence`; node consumes state.
6. **`subgraphs/trial-eval/graph.ts`** — reorder edges; new graph wiring test.
7. **`synthesize-match` node + prompt** — drop citations block from prompt; populate `mechanismEvidence` + `counterEvidenceAddressed`; PMID-echo filter; updated concerns.
8. **`docs/topology.md`** — describe the new flow and the evidence trail.
9. **Live e2e smoke** via playwright-cli on Hedy Sauer; verify `mechanismEvidence` is populated, counter-evidence is exercised, score range looks sane.

Expected effort: ~1 day for an implementer following the plan.
