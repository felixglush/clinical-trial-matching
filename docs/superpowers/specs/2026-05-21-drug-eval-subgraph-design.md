# drug-eval subgraph + txGNN-backed find-repurposing-candidates: Design

**Date:** 2026-05-21
**Status:** Draft (pending user review)
**Scope:** A new `subgraphs/drug-eval` per-candidate fan-out, plus a full rewrite of the stub `find-repurposing-candidates.ts` to use **pre-computed TxGNN predictions** (no model hosting). Parent `graph.ts` wires the fan-out and a new `drugMatches` annotation.

**Out of scope (this spec):**
- Hosting / inference of the TxGNN model. We use only the publicly distributed prediction tables.
- Fine-tuning or extending TxGNN.
- Changes to `identify-relevant-mechanisms`, beyond surfacing each mechanism's MONDO id cleanly for downstream lookup.
- Refactoring `trial-eval` subgraph.

## Goal

Bring drug-repurposing onto the same evidence-integration footing as trial-matching. For each kept patient mechanism, look up TxGNN's top drug candidates, then evaluate each candidate against four signals — KG-derived mechanism path, patient-fit (contraindications vs. profile), literature support, active-trial availability — and synthesize a `DrugMatch`. The agent's novel claim is the *integration*, not beating TxGNN's AUPRC.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Candidate retrieval | Pre-computed TxGNN prediction dump, JSON, in-memory at runtime | Lookup-only constraint; mirrors `snomed-to-primekg.json` approach. No GPU, no model hosting. |
| Fan-out width | Top-N per kept mechanism (default `N=10`), deduped across mechanisms | ≤5 mechanisms × 10 ≈ 50 pre-dedup, comfortably bounded fan-out. Broader than "top mechanism only", cheaper than thresholding all of TxGNN. |
| `patient-fit` evaluation | Hybrid: deterministic Cypher (PrimeKG contraindication / side_effect edges) then LLM narration over the hit list + profile | Deterministic on the safety bit; LLM only narrates. Keeps PrimeKG load-bearing. |
| Mechanism-plausibility for drugs | New drug-shaped prompt sibling under `prompts/`, called by a new `mechanism-plausibility-drug` node | Existing prompt is trial-shaped ("does this trial's intervention target..."). Same skeleton, different prompt body. |
| Literature support | Reuse `tools/pubmed.ts` and the existing `literature-support` node logic, parameterized for `(drug, disease)` queries | No new tooling needed; PubMed search is already proven. |
| Trial-availability check | New `trial-availability` node; calls `tools/clinicaltrials.ts` for active trials of `(drug, disease)`. Lookup-only. | Closes the loop the essay calls out: "for each candidate, does an active trial exist?" |
| TxGNN explanation paths | Persist alongside scores in a separate JSON; fall back to PrimeKG metapath Cypher when missing | Some (drug, disease) pairs in the dump lack explainer output; the agent should degrade gracefully, not skip the candidate. |
| Data layout | Two committed JSON artifacts under `apps/agent/src/data/`: `txgnn-predictions.json`, `txgnn-explanations.json` | Matches the SSSOM-crosswalk pattern. Boots offline on LangGraph Platform; runtime is I/O-free. |
| Build pipeline | New `pnpm kg:build-txgnn` script consumes the publicly distributed TxGNN dump and emits both JSONs | Symmetrical with `pnpm kg:build-crosswalk`. **TxGNN distribution format is unverified — see Risks.** |

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Build-time (one-shot, offline; new pnpm script)                    │
│                                                                     │
│   TxGNN dump (txgnn.org / mims-harvard/TxGNN) ─┐                    │
│       (predictions + explainer paths)          │                    │
│                                                ▼                    │
│                          scripts/build-txgnn-data.ts                │
│                          ├─► filter (predIndication > 0.5           │
│                          │           AND > predContraindication)    │
│                          ├─► sort + cap top-50 per MONDO            │
│                          └─► type-normalize node types              │
│                                                                     │
│   apps/agent/src/data/txgnn-predictions.json    (committed)         │
│   apps/agent/src/data/txgnn-explanations.json   (committed)         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Runtime — find-repurposing-candidates (replaces stub)              │
│                                                                     │
│   state.mechanisms (≤5, MONDO-keyed)                                │
│       │                                                             │
│       ▼                                                             │
│   For each mechanism:                                               │
│     preds = lookupPredictions(mondoId, topN=10)                     │
│     for each pred:                                                  │
│       explanation = lookupExplanation(mondoId, drugId) | null       │
│       → RepurposingCandidate{drugId, drugName,                      │
│           sourceMechanisms:[conditionId], predIndication,           │
│           predContraindication, explanationPath}                    │
│       │                                                             │
│   Dedup across mechanisms by drugId:                                │
│       keep highest predIndication, UNION sourceMechanisms           │
│       │                                                             │
│   Log uncovered MONDO ids (graceful miss)                           │
│       │                                                             │
│       ▼                                                             │
│   state.repurposingCandidates  (≤50)                                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Parent graph — Send fan-out                                        │
│                                                                     │
│   find-repurposing-candidates                                       │
│       │  Send(candidate) per repurposingCandidate                   │
│       ▼                                                             │
│   drug-eval-subgraph (parallel instances)                           │
│       │                                                             │
│       ▼                                                             │
│   state.drugMatches (concat reducer)                                │
│       │                                                             │
│       ▼                                                             │
│   rank-and-synthesize (merges matches + drugMatches into brief)     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  drug-eval subgraph (per candidate)                                 │
│                                                                     │
│   START                                                             │
│     │                                                               │
│     ▼                                                               │
│   validate-explanation-path                                         │
│     ├─ If candidate.explanationPath present:                        │
│     │    normalize node types (gene/protein → gene_protein),        │
│     │    fill display names from PrimeKG if missing                 │
│     └─ Else (fallback): metapath Cypher                             │
│          (drug)-[:`target`]-(g)-[:`interacts with`]-(bp)-           │
│          [:`assoc`]-(disease)                                       │
│     │                                                               │
│     ▼                                                               │
│   patient-fit                                                       │
│     A. Deterministic Cypher:                                        │
│        MATCH (d:drug {id:$drugId})-[r:contraindication|side_effect] │
│              -(x) WHERE x.id IN $patientConditionIds RETURN ...     │
│     B. LLM narration (structured output):                           │
│        {verdict: ok|caution|avoid, concerns[], doseNotes}           │
│     │                                                               │
│     ├──(verdict = avoid)──► synthesize-drug-match (early exit:      │
│     │                       DrugMatch.status = "filtered")          │
│     │                                                               │
│     ▼ (verdict ∈ {ok, caution})                                     │
│   mechanism-plausibility-drug                                       │
│     LLM: "Does this drug's MoA plausibly hit this patient's         │
│           mechanism?" Reuses node skeleton; new prompt sibling.     │
│     │                                                               │
│     ▼                                                               │
│   literature-support-drug                                           │
│     PubMed: "{drug} {disease}", "{drug} {pathway}"                  │
│     (reuses tools/pubmed.ts; logic mirrors trial-eval's lit node)   │
│     │                                                               │
│     ▼                                                               │
│   trial-availability                                                │
│     ClinicalTrials.gov: intervention=drug, condition=disease,       │
│     recruitingStatus=active. Output: count + top-3 NCT ids.         │
│     │                                                               │
│     ▼                                                               │
│   synthesize-drug-match                                             │
│     Combine into DrugMatch{score, rationale, contraindications,     │
│     literature, trialNCTs}                                          │
│     │                                                               │
│     ▼                                                               │
│   END                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

## Thresholds and filters (for review)

These are the tunable knobs in this design. Captured here so we can revisit during implementation and after first runs against real patients. **Treat as defaults, not commitments.**

### Build-time (offline TxGNN ingestion)

| Knob | Default | What it does | Notes for review |
|---|---|---|---|
| `predIndication` cutoff | `> 0.5` | Drop predictions below cutoff before serializing | Half the probability mass. Could be too generous; TxGNN's calibration on PrimeKG hasn't been spot-checked yet. |
| `predIndication > predContraindication` | required | Drop entries where contraindication signal dominates | Conservative; pure indication-rank ignores the contra signal entirely. |
| Top-K per disease | `50` | Cap the per-MONDO drug list size | Bounds storage; runtime lookup uses `topN ≤ 10`, so 50 leaves headroom. |
| Explanation persistence | Only for kept (disease, drug) pairs | Skip explanations for dropped pairs | Keeps the explanations file small. |
| Type normalization | `gene/protein → gene_protein` (mirrors `kg.ts`) | Normalize PrimeKG raw types at the boundary | Already a project convention. |

### Runtime — `find-repurposing-candidates`

| Knob | Default | What it does |
|---|---|---|
| `topN` per mechanism | `10` | How deep into TxGNN's per-disease ranking we go |
| Dedup policy | Keep highest `predIndication`, UNION `sourceMechanisms` | One drug appearing for multiple patient diseases is surfaced once with both source mechanisms attached |
| Coverage logging | `isCovered(mondoId) === false` → `console.warn` | Symmetric with the unresolved-SNOMED logging in `identify-relevant-mechanisms` |

### Runtime — `drug-eval` subgraph

| Knob | Default | What it does |
|---|---|---|
| `patient-fit` verdict scale | `{ok, caution, avoid}` | `avoid` triggers early exit to `synthesize-drug-match` with `status: "filtered"` |
| Contraindication edge set | `contraindication`, `side_effect` | Which PrimeKG drug-edge labels count as "hit" against patient conditions |
| PubMed query templates | `"{drug} {disease}"`, `"{drug} {pathway}"` | Per-candidate literature queries |
| `trial-availability` cap | Top-3 NCT ids, `recruitingStatus=active` | Avoids drowning the rationale in trial lists |
| Metapath fallback | `(drug)-[:target]-(g)-[:interacts]-(bp)-[:assoc]-(disease)` | Only fires when TxGNN dump lacks an explanation for a (drug, disease) pair |

### Final-synthesis (open)

| Knob | Default | What it does |
|---|---|---|
| `DrugMatch.score` formula | **TBD during implementation** | Combine `predIndication`, patient-fit verdict, literature support, trial availability into a single score. Start with a transparent weighted sum; revisit. |
| Drug-vs-trial precedence in `rank-and-synthesize` | **TBD** | When the same disease has both a strong trial match and a strong drug repurposing candidate, do we co-rank or separate sections? |

## State shape changes

`apps/agent/src/state.ts`:

```ts
drugMatches: Annotation<DrugMatch[]>({
  reducer: (prev, next) => prev.concat(next),
  default: () => [],
}),
```

`repurposingCandidates` reducer stays single-shot (the rewritten `find-repurposing-candidates` emits the merged list once).

Types in `@clinical-trial-matching/shared`:

**Existing — `RepurposingCandidateSchema` in `packages/shared/src/repurposing.ts`:**
```ts
{ drug: KGNode, originalIndications: string[], rationale: string, supportingPaths: KGPath[] }
```
**Extend with TxGNN-specific fields (the rationale string and supportingPaths array carry over — `supportingPaths: [explanationPath]` when present, `[]` when the fallback Cypher fails too):**
```ts
sourceMechanisms: string[]          // conditionIds of patient diseases this candidate came from (post-dedup)
predIndication: number              // from TxGNN
predContraindication: number        // from TxGNN
```
`rationale` is populated by `find-repurposing-candidates` with a brief one-liner ("Top-N TxGNN indication for {disease}, predIndication={x}"); the richer per-signal narrative lives on `DrugMatch` downstream.

**New types:**
- `TxGNNPrediction` — `{drugId, drugName, predIndication, predContraindication}` (internal to `tools/txgnn.ts` lookup return)
- `PatientFitAssessment` — `{verdict: "ok" | "caution" | "avoid", concerns: string[], doseNotes: string}`
- `ContraindicationHit` — `{patientConditionId, drugEdge: "contraindication" | "side_effect", linkedNode: KGNode}`
- `TrialAvailability` — `{activeTrialCount: number, topTrialNCTs: string[]}`
- `DrugMatch` — `{candidate: RepurposingCandidate, score: number, status: "ok" | "caution" | "filtered", patientFit: PatientFitAssessment, mechanismPlausibility: ..., literatureSupport: ..., trialAvailability: TrialAvailability}` (final shape; mirrors `TrialMatch` once we look at it during implementation)

The compile-time `_AgentStateMatchesGraphState` guard in `state.ts` requires `GraphState` in shared to mirror these additions.

## Do I still need PrimeKG?

**Yes.** Three load-bearing roles, none replaceable by the TxGNN dump:

1. **`patient-fit` Step A** — deterministic Cypher for contraindication / side_effect edges against patient conditions. TxGNN gives scores, not the edge inventory.
2. **`validate-explanation-path` fallback** — metapath Cypher when a (drug, disease) pair has no explainer in the dump. Optional: dropping this fallback means skipping candidates without distributed explanations.
3. **`identify-relevant-mechanisms`** — already PrimeKG-backed; the per-disease gene/pathway enumeration feeds both `mechanism-plausibility` prompts (trial *and* drug). TxGNN doesn't replace the patient-side mechanism narrative.

**What TxGNN narrowly replaces:** the `kg.findDrugsTargetingPathways()` TODO in the current `find-repurposing-candidates` stub (pathway-intersection ranking). The paper beats that naive baseline by a large margin in zero-shot.

**No infra simplification:** Neo4j container + SNOMED→MONDO crosswalk both stay in the dev loop.

## Error model

Mirrors `identify-relevant-mechanisms`'s philosophy: never silently degrade downstream.

| Failure | Handling |
|---|---|
| 0 mechanisms in state | `{repurposingCandidates: []}`, no error |
| Some mechanism MONDOs uncovered by TxGNN | Process covered ones, `console.warn` the misses |
| All mechanisms uncovered | `{repurposingCandidates: []}`, no error (warn already emitted) |
| TxGNN data file missing / malformed at boot | `{error}` — build-time bug, fail loud |
| Cypher throws in `patient-fit` Step A or `validate-explanation-path` fallback | Per-candidate `{error}`; other candidates continue |
| LLM failure in `patient-fit` Step B or `mechanism-plausibility-drug` | Per-candidate `{error}`; other candidates continue |
| `clinicaltrials.gov` API failure | `trialAvailability = {activeTrialCount: null, topTrialNCTs: []}`, soft-degrade; not a per-candidate error |

No in-node retries.

## Risks and open items

1. **TxGNN distribution format unverified.** I know the predictions are public (github.com/mims-harvard/TxGNN, txgnn.org) but haven't confirmed: file format (CSV/TSV/parquet), exact schema, whether explainer paths ship alongside scores or must be regenerated, and the dataset's license. **Implementation should start with an Explore-agent pass over the repo README + Harvard Dataverse listing to lock the loader contract.**
2. **TxGNN coverage of the patient's MONDO ids.** TxGNN covers ~17k diseases but PrimeKG covers more. Patients with rare-disease MONDO codes outside the TxGNN training set will get empty results from `find-repurposing-candidates`. Handled gracefully (empty list, not error) — but it's a real coverage ceiling.
3. **Score calibration drift.** The `> 0.5` indication threshold is a guess. After first runs, eyeball the top-K outputs for known disease/drug pairs and adjust.
4. **`DrugMatch.score` formula.** Deliberately TBD. Implementation can start with a transparent weighted sum (predIndication × 0.4 + literatureSupport × 0.3 + mechanismPlausibility × 0.2 + (1 − patientFitConcernCount/N) × 0.1) and we revisit after first runs.
5. **Fan-out cost.** ~50 candidates × {1 Cypher + 1 LLM + 1 PubMed + 1 CT.gov + 1 LLM} ≈ 250 model + 100 HTTP calls per patient. Within budget for prototype; worth measuring before extending.
6. **`trial-availability` overlap with the trial-search branch.** A drug-repurposing candidate may surface a trial that the trial-matching branch *also* surfaces (different entry point, same NCT). `rank-and-synthesize` will need to dedup at the NCT level. Flagged for that node's design; not solved here.

## Testing

Following the repo conventions in `docs/codebase-conventions.md`:

- **`tools/txgnn.test.ts`** — pure-function tests against a small fixture dump (a handful of MONDO ids, a handful of drugs). Covers `lookupPredictions`, `lookupExplanation`, `isCovered`, topN clamping, type normalization.
- **`nodes/find-repurposing-candidates.test.ts`** — feeds fixtures into the rewritten node, asserts dedup across mechanisms, sourceMechanisms union, uncovered-MONDO warning behavior, empty-input non-error.
- **`subgraphs/drug-eval/*.test.ts`** — per-node tests using existing mocking patterns (LLM via `withStructuredOutput` stubs; Neo4j via the existing test driver).
- **No live TxGNN/PubMed/CT.gov calls in unit tests.** Integration smoke covered by an end-to-end fixture patient (one well-covered cancer MONDO + one rare-disease MONDO to exercise both covered and uncovered paths).
