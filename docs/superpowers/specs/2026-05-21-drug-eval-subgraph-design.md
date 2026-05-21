# TxGNN-backed drug repurposing as a trial-discovery channel: Design

**Date:** 2026-05-21
**Status:** Draft v2 (pending user review)
**Supersedes:** v1 of this file (which proposed a parallel `drug-eval` subgraph). v2 keeps the TxGNN integration but drops the subgraph in favor of feeding repurposing candidates into the existing trial-discovery and trial-evaluation pipeline.

**Scope:**
- Full rewrite of the stub `find-repurposing-candidates.ts` to use **pre-computed TxGNN predictions** (no model hosting).
- `search-trials` implementation: consumes both `state.searchStrategy` and `state.repurposingCandidates`, unions and dedupes by `nctId` (intent already documented in `search-trials.ts:7`).
- `trial-eval-subgraph` enrichment: populate `TrialMatch.repurposingRationale` (field already exists in `packages/shared/src/trial.ts:35`) when a trial was surfaced via a TxGNN candidate; pass that context into `mechanism-plausibility`.
- New eligibility sub-check: deterministic Cypher for **trial-intervention vs. patient-condition** contraindications, folded into the existing `eligibility-check` node (not a new subgraph).
- `rank-and-synthesize` appendix: TxGNN candidates whose drug appears in zero matched trials surface as "no-trial repurposing leads" for clinician followup.

**Out of scope (this spec):**
- Hosting / inference of the TxGNN model. Only the publicly distributed prediction tables.
- Any new subgraph. The existing `trial-eval` subgraph handles per-trial evaluation regardless of how the trial was discovered.
- Changes to `identify-relevant-mechanisms`, beyond ensuring each mechanism's MONDO id is accessible to downstream lookup.
- Fine-tuning or extending TxGNN.

## Goal

Bring drug-repurposing into the agent as a **second trial-discovery channel and a source of clinician-readable rationale**, not as a parallel output. The end deliverable remains a ranked list of trials for the patient. Repurposing serves three purposes:

1. **Discovery.** Query CT.gov by predicted intervention drug names in addition to mechanism keywords; surfaces trials a pure keyword search misses.
2. **Provenance & rationale.** When a matched trial is one of the channel's hits, `TrialMatch.repurposingRationale` carries the *why* — "TxGNN predicted this drug for the patient's MONDO id with score X, via this explanation path."
3. **Lead generation.** TxGNN candidates whose drugs *don't* yield any matched trial are surfaced as a short appendix ("repurposing leads worth manual followup") — explicit, not silently dropped.

The novel claim of the project is still the *integration layer*. TxGNN does the ranking; we compose it with patient-side mechanism enumeration, CT.gov, PubMed, eligibility reasoning, and KG-derived safety checks.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Candidate retrieval | Pre-computed TxGNN prediction dump, JSON, in-memory at runtime | Lookup-only constraint; mirrors `snomed-to-primekg.json`. No GPU, no model hosting. |
| TxGNN candidate width | Top-N per kept mechanism (default `N=10`), deduped across mechanisms by `drugId` | ≤5 mechanisms × 10 ≈ 50 pre-dedup. Each candidate is a CT.gov query term, not a per-candidate fan-out. |
| Repurposing as a trial-discovery channel | `search-trials` takes union over (search-strategy query) and (per-candidate intervention queries), dedupes by `nctId` | Already telegraphed by the TODO in `search-trials.ts:7`. Single evaluator downstream. |
| Trial-eval enrichment | Populate `TrialMatch.repurposingRationale` when the trial came from the repurposing channel; pass to `mechanism-plausibility` as context | The field already exists in the shared schema. No new type. |
| Patient-fit safety check for trial interventions | Deterministic Cypher (`drug ─[contraindication\|side_effect]─> condition`) inside the existing `eligibility-check` node; LLM narrates concerns alongside the structured I/E criteria check | Belongs with eligibility; not a separate node. Fires on *any* trial intervention, regardless of discovery channel. |
| "No-trial leads" appendix | `rank-and-synthesize` filters `state.repurposingCandidates` down to those whose `drug.id` (or normalized drug name) does not appear in any `state.matches[].interventions`, and appends them to the brief | Lightweight: one set-difference + a short narrative per surviving candidate. No subgraph, no per-candidate LLM fan-out. |
| Drug → trial intervention name matching | Build a normalized name map (lowercased + stripped of formulation suffixes) for CT.gov interventions; match TxGNN drug names against it | Brittle compared to a real RxNorm/DrugBank crosswalk. Acceptable for prototype; flag for hardening later. |
| TxGNN explanation paths | Persist alongside scores in a separate JSON; surface in `RepurposingCandidate.supportingPaths` (existing field) | Fits the existing schema. Fallback to PrimeKG metapath Cypher only if explainer is missing AND a matched trial needs the rationale (lazy, not eager). |
| Data layout | Two committed JSON artifacts under `apps/agent/src/data/`: `txgnn-predictions.json`, `txgnn-explanations.json` | Matches SSSOM-crosswalk pattern. Boots offline on LangGraph Platform; runtime is I/O-free. |
| Build pipeline | New `pnpm kg:build-txgnn` script consumes the public TxGNN dump and emits both JSONs | Symmetric with `pnpm kg:build-crosswalk`. **TxGNN distribution format is unverified — see Risks.** |

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
│                          └─► type-normalize (gene/protein →         │
│                              gene_protein, mirrors kg.ts)           │
│                                                                     │
│   apps/agent/src/data/txgnn-predictions.json    (committed)         │
│   apps/agent/src/data/txgnn-explanations.json   (committed)         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Runtime — full flow                                                │
│                                                                     │
│   extract-patient-profile                                           │
│       │                                                             │
│       ▼                                                             │
│   identify-relevant-mechanisms  (unchanged; emits Mechanism[])      │
│       │                                                             │
│       ├──► find-repurposing-candidates   (REWRITTEN, TxGNN-backed)  │
│       │      for each mechanism:                                    │
│       │        preds = lookupPredictions(mondoId, topN=10)          │
│       │        for each pred: emit RepurposingCandidate{            │
│       │          drug: KGNode,                                      │
│       │          originalIndications: [from TxGNN],                 │
│       │          rationale: brief one-liner,                        │
│       │          supportingPaths: [explanationPath or fallback]     │
│       │        }                                                    │
│       │      dedup across mechanisms by drug.id                     │
│       │      log uncovered MONDO ids (graceful miss)                │
│       │      → state.repurposingCandidates  (≤50)                   │
│       │                                                             │
│       └──► generate-search-strategy   (unchanged)                   │
│                                                                     │
│                          ▼                          ▼               │
│                       search-trials  ◄──────────────┘               │
│                       (REWRITTEN — two CT.gov queries:              │
│                          (1) searchStrategy condition+mech terms    │
│                          (2) per repurposingCandidate.drug.name     │
│                              as intervention=...                    │
│                        union + dedupe by nctId                      │
│                        → state.candidates)                          │
│                                │                                    │
│                                ▼                                    │
│                       pre-filter ─loop─► generate-search-strategy   │
│                                │                                    │
│                                ▼                                    │
│   trial-eval-subgraph  (per trial; existing 4 nodes, two enriched)  │
│     ├─ eligibility-check  (ENRICHED: also runs deterministic        │
│     │     Cypher for intervention ─[contraindication|side_effect]   │
│     │     → patient condition; concerns surface in eligibility      │
│     │     assessment)                                               │
│     ├─ mechanism-plausibility  (ENRICHED: when the trial is in the  │
│     │     repurposing-channel hit set, prompt includes the          │
│     │     candidate's supportingPaths as additional evidence)       │
│     ├─ literature-support     (unchanged)                           │
│     └─ synthesize-match       (ENRICHED: populates                  │
│         repurposingRationale when applicable)                       │
│                                │                                    │
│                                ▼                                    │
│   rank-and-synthesize                                               │
│     - rank state.matches                                            │
│     - compute appendix: repurposingCandidates whose drug name is    │
│       not in any match.interventions → "no-trial leads" list        │
│     - emit final brief: main ranked trials + appendix               │
│                                │                                    │
│                                ▼                                    │
│   human-approval → END                                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Thresholds and filters (for review)

Tunable knobs in this design, captured for revisit during implementation and after first runs. **Treat as defaults, not commitments.**

### Build-time (offline TxGNN ingestion)

| Knob | Default | What it does | Notes for review |
|---|---|---|---|
| `predIndication` cutoff | `> 0.5` | Drop predictions below cutoff before serializing | Half the probability mass. TxGNN's calibration on PrimeKG hasn't been spot-checked. |
| `predIndication > predContraindication` | required | Drop entries where contraindication dominates | Conservative; pure indication-rank would ignore contra signal. |
| Top-K per disease | `50` | Cap per-MONDO drug list size | Bounds storage; runtime uses `topN ≤ 10`, so 50 leaves headroom. |
| Explanation persistence | Only for kept (disease, drug) pairs | Skip explanations for dropped pairs | Keeps explanations file small. |
| Type normalization | `gene/protein → gene_protein` (mirrors `kg.ts`) | Normalize PrimeKG raw types at boundary | Project convention. |

### Runtime — `find-repurposing-candidates`

| Knob | Default | What it does |
|---|---|---|
| `topN` per mechanism | `10` | How deep into TxGNN's per-disease ranking we go |
| Dedup policy | Keep highest `predIndication` across mechanisms by `drug.id`; union `originalIndications` | One drug appearing for multiple patient diseases surfaces once with both source diseases attached |
| Coverage logging | `isCovered(mondoId) === false` → `console.warn` | Symmetric with unresolved-SNOMED logging in `identify-relevant-mechanisms` |
| Explanation fallback | Lazy: only re-derive via metapath Cypher when the trial-eval pipeline actually consumes the path for an unexplained match | Avoids paying Neo4j cost for candidates that don't yield a matched trial |

### Runtime — `search-trials`

| Knob | Default | What it does |
|---|---|---|
| Per-candidate intervention query | One CT.gov query per repurposingCandidate, `intervention=<drug.name>` | Optionally also `condition=<sourceMechanism.diseaseName>` to constrain; needs experimentation |
| Dedup key | `nctId` | A trial discovered by both channels appears once; provenance attached |
| Trial result cap per channel | **TBD during implementation** (start: top-50 per query) | Bound the CT.gov payload |

### Runtime — `trial-eval` enrichment

| Knob | Default | What it does |
|---|---|---|
| Contraindication edge set | `contraindication`, `side_effect` | Which PrimeKG drug-edge labels count as "hit" in `eligibility-check`'s intervention safety step |
| Repurposing context in `mechanism-plausibility` | Pass `supportingPaths` of the source RepurposingCandidate into the prompt as additional evidence | Only when a trial was discovered via the repurposing channel; otherwise unchanged |

### Runtime — `rank-and-synthesize` appendix

| Knob | Default | What it does |
|---|---|---|
| Match-attribution method | Normalized drug-name string match between `RepurposingCandidate.drug.name` and `TrialMatch.interventions[]` | Brittle; flagged as a hardening target (RxNorm/DrugBank crosswalk would be cleaner) |
| Appendix length cap | Top-10 by `predIndication` | Avoids dumping all 50 candidates into the brief |
| Appendix narrative | One-line per candidate: drug name, predicted indication, source MONDO, "no active trials matched" | Keeps brief readable |

### Open (deliberate TBDs)

| Knob | Why TBD |
|---|---|
| `DrugMatch.score` formula | **N/A in v2** — `DrugMatch` no longer exists. `TrialMatch.score` formula stays in the `trial-eval` / `rank-and-synthesize` domain. |
| Drug-vs-trial precedence | **N/A in v2** — single ranked trial list with an appendix; no precedence question. |
| Per-candidate CT.gov query shape (`intervention` only vs. `intervention+condition`) | Want to see empirical recall/precision before locking |

## State shape changes

`apps/agent/src/state.ts`:

- `repurposingCandidates` — already exists. Reducer stays single-shot. Filled by `find-repurposing-candidates`, consumed by `search-trials` (discovery) and `rank-and-synthesize` (appendix attribution).
- No new top-level annotation. Specifically: **no `drugMatches`** — that was the v1 mistake.

`packages/shared/src/`:

- `RepurposingCandidateSchema` (in `repurposing.ts`) — minor extension:
  ```ts
  predIndication: z.number().optional()
  predContraindication: z.number().optional()
  ```
  Optional because not every consumer needs them; populated by `find-repurposing-candidates`.
- `RepurposingRationaleSchema` (in `repurposing.ts`) — already used by `TrialMatch.repurposingRationale`. May need a small extension to carry `predIndication` if we want it on the brief; check during implementation.
- `TrialMatchSchema` — no change. `repurposingRationale: RepurposingRationaleSchema.nullable()` already there.
- `EligibilityAssessmentSchema` — extend to carry the intervention-contraindication concerns (added during `eligibility-check` enrichment). Exact shape decided in implementation.

The compile-time `_AgentStateMatchesGraphState` guard in `state.ts` enforces synchrony.

## Do I still need PrimeKG?

**Yes.** Three load-bearing roles, none replaceable by the TxGNN dump:

1. **`eligibility-check`'s intervention safety step** — deterministic Cypher for `contraindication` / `side_effect` edges between each trial's interventions and the patient's conditions. TxGNN gives scores, not the edge inventory.
2. **Explanation-path fallback for matched trials lacking distributed explanations.** Lazy: only fires for trials that actually surface in `state.matches` and whose source repurposing candidate has no explainer in the dump. Optional: dropping this means matched trials without a TxGNN explainer get a `null` `repurposingRationale.supportingPaths` rather than a Cypher-derived one.
3. **`identify-relevant-mechanisms`** — already PrimeKG-backed; per-disease gene/pathway enumeration feeds `mechanism-plausibility`. TxGNN doesn't replace the *patient-side* mechanism narrative.

**What TxGNN narrowly replaces:** the `kg.findDrugsTargetingPathways()` TODO in `find-repurposing-candidates.ts` (naive pathway-intersection ranking). TxGNN beats that baseline by a large margin in zero-shot.

**No infra simplification:** Neo4j container + SNOMED→MONDO crosswalk both stay.

## Error model

Mirrors `identify-relevant-mechanisms`'s philosophy: never silently degrade downstream.

| Failure | Handling |
|---|---|
| 0 mechanisms in state | `find-repurposing-candidates` returns `{repurposingCandidates: []}`; `search-trials` falls back to the search-strategy channel only |
| Some mechanism MONDOs uncovered by TxGNN | Process covered ones, `console.warn` the misses |
| All mechanism MONDOs uncovered | `{repurposingCandidates: []}`, no error; search-strategy channel still runs |
| TxGNN data file missing / malformed at boot | `{error}` — build-time bug, fail loud |
| CT.gov failure on the repurposing-channel queries | Soft-degrade: skip that channel's contribution, search-strategy channel still runs; warn-log |
| Cypher throws in `eligibility-check`'s safety step | The eligibility check still runs (LLM side); structured concerns are empty + flagged "safety check unavailable" |
| Cypher throws in explanation-path fallback for a matched trial | `repurposingRationale.supportingPaths` is `null` for that match; trial still surfaces |

No in-node retries.

## Risks and open items

1. **TxGNN distribution format unverified.** Predictions are public (github.com/mims-harvard/TxGNN, txgnn.org) but I haven't confirmed: file format (CSV/TSV/parquet), exact schema, whether explainer paths ship alongside scores or must be regenerated, license. **Implementation should start with an Explore-agent pass over the repo README + Harvard Dataverse listing to lock the loader contract.**
2. **TxGNN coverage of patient MONDO ids.** TxGNN covers ~17k diseases; patients with rare-disease MONDO codes outside its training set get empty results from `find-repurposing-candidates`. The search-strategy channel still runs, so the patient still gets trial matches — just no repurposing-channel-discovered ones.
3. **Drug-name → CT.gov intervention matching is brittle.** Lowercased string matching against `TrialMatch.interventions[]` will miss drug aliases, salt forms, brand-vs-generic. Acceptable for prototype; flag for hardening with RxNorm or DrugBank crosswalk later.
4. **Score-calibration drift.** The `> 0.5` indication threshold is a guess. Eyeball top-K on known disease/drug pairs after first runs; adjust.
5. **CT.gov query budget.** Up to 50 repurposing candidates → up to 50 extra CT.gov queries per patient. Acceptable for prototype; consider batching or capping by `predIndication` if rate-limited.
6. **Repurposing candidates without source-mechanism trial overlap could be either signal or noise.** A TxGNN-predicted drug with zero matching trials might be (a) a genuinely novel repurposing idea worth manual followup, or (b) a low-quality prediction. Appendix surfaces them all (up to cap); downstream human review separates them.

## Testing

Following `docs/codebase-conventions.md`:

- **`tools/txgnn.test.ts`** — pure-function tests against a small fixture dump (handful of MONDO ids, handful of drugs). Covers `lookupPredictions`, `lookupExplanation`, `isCovered`, topN clamping, type normalization.
- **`nodes/find-repurposing-candidates.test.ts`** — feeds fixtures into the rewritten node, asserts: dedup across mechanisms by `drug.id`, `originalIndications` union, uncovered-MONDO warning behavior, empty-input non-error.
- **`nodes/search-trials.test.ts`** — fixture state with both `searchStrategy` and `repurposingCandidates`; asserts union + dedup by `nctId`, and that a trial discovered only via the repurposing channel still ends up in `candidates`.
- **`subgraphs/trial-eval/nodes/eligibility-check.test.ts`** — fixture trial with an intervention that has a contraindication edge against a patient condition; asserts the concern surfaces in `EligibilityAssessment`.
- **`subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`** — fixture trial discovered via the repurposing channel; asserts the candidate's `supportingPaths` reach the prompt context.
- **`nodes/rank-and-synthesize.test.ts`** — fixture state with `repurposingCandidates` (5 candidates) and `matches` (interventions covering 3 of those 5); asserts the appendix surfaces exactly the 2 unmatched candidates, ordered by `predIndication`.
- **No live TxGNN/PubMed/CT.gov calls in unit tests.** Integration smoke: end-to-end fixture patient with one well-covered MONDO + one uncovered MONDO; assert both paths handled.
