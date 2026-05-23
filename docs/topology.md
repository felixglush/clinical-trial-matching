# LangGraph topology reference

The patient-to-trial matching workflow as a directed graph. This document describes what each node reads, computes, and writes — and how the edges connect them. Companion to the design spec (`docs/superpowers/specs/2026-05-19-skeleton-design.md`).

The graph is defined in [apps/agent/src/graph.ts](../apps/agent/src/graph.ts). State annotation in [apps/agent/src/state.ts](../apps/agent/src/state.ts).

## Topology at a glance

```
                            START
                              ↓
                  extract-patient-profile
                              ↓
                identify-relevant-mechanisms
                       ↓             ↓
       find-repurposing-      generate-search-
            candidates              strategy
                       ↘             ↙
                        search-trials
                              ↓
                          pre-filter
                              ↓
                  routeAfterPreFilter ──┐
                              ↓        │ broaden loop
                              ↓        │ (back to generate-search-strategy)
                       Send × N        │
                              ↓        ↓
                    trial-eval-subgraph
                              ↓
                     rank-and-synthesize
                              ↓
                       human-approval  ← interrupt() pauses here
                              ↓
                             END
```

## State

`AgentState` (parent graph) carries everything that flows between nodes. Schemas live in `packages/shared/`.

| Field | Type | Reducer | Set by | Used by |
|---|---|---|---|---|
| `patientId` | `string` | replace | START input | every node |
| `patientProfile` | `PatientProfile \| null` | replace | extract-patient-profile | every downstream node |
| `mechanisms` | `Mechanism[]` | replace | identify-relevant-mechanisms | find-repurposing, generate-search-strategy, trial-eval (per-candidate copy) |
| `repurposingCandidates` | `RepurposingCandidate[]` | replace | find-repurposing-candidates | search-trials, trial-eval |
| `searchStrategy` | `SearchStrategy \| null` | replace | generate-search-strategy | search-trials, generate-search-strategy (for broadening) |
| `candidates` | `TrialCandidate[]` | replace | search-trials, pre-filter | pre-filter, routeAfterPreFilter, fan-out |
| `candidateDrops` | `CandidateDrop[]` | replace | pre-filter | UI (audit display) |
| `matches` | `TrialMatch[]` | **concat** | trial-eval-subgraph (via Send) | rank-and-synthesize |
| `attempts` | `number` | replace | generate-search-strategy (increment) | routeAfterPreFilter (cap at 3) |
| `approvalRequest` | `ApprovalRequest \| null` | replace | rank-and-synthesize | human-approval |
| `error` | `string \| null` | replace | human-approval (on reject) | terminal |

The `matches` reducer is **concat**, which is critical: when fan-out fires N parallel `trial-eval-subgraph` invocations and each returns one `TrialMatch`, they all get appended to the same array rather than overwriting each other. Every other reducer is "last-write wins."

## Top-level nodes

### `extract-patient-profile`

**Reads:** `patientId`
**Writes:** `patientProfile`
**Tools:** `loadPatientBundle(patientId)` → raw FHIR Bundle
**Prompt:** `extractProfilePrompt(fhirBundle)`
**LLM call:** Yes — takes a FHIR Bundle (often hundreds of resources) and distills it to a structured `PatientProfile` (demographics, conditions, meds, labs, prior treatments).

Why an LLM and not deterministic FHIR parsing? FHIR data is messy — duplicate conditions, coded values with no clinical importance, lab values without context. An LLM produces a *clinically meaningful* summary, not a literal projection.

### `identify-relevant-mechanisms`

**Reads:** `patientProfile`
**Writes:** `mechanisms`
**Tools:** `kg.buildMechanismsForConditions(conditionIds)` — Cypher queries against PrimeKG
**Prompt:** `mechanismPrompt(profile, kgFindings)`

For each condition in the patient's profile, traverses the KG to find:
- Gene/protein targets (`Disease`–`disease_protein`→`GeneProtein`)
- Pathways / biological processes (`GeneProtein`–`protein_protein`→`GeneProtein`–`bioprocess_protein`→`BiologicalProcess`)
- Supporting paths (the actual graph paths used as evidence)

The LLM then prunes and prioritizes — not every KG path is clinically meaningful for this patient. Output is a small `Mechanism[]` per condition.

### `find-repurposing-candidates`

**Reads:** `mechanisms`
**Writes:** `repurposingCandidates`
**Tools:** `kg.findDrugsTargetingPathways(pathwayIds)` — Cypher to find drugs that target the identified pathways via known indications
**Prompt:** `repurposingPrompt(mechanisms, candidates)`

Finds drugs that are *already approved* for some other indication but target the same pathways relevant to this patient's conditions. The LLM articulates why each candidate is biologically plausible. Output: `RepurposingCandidate[]` with rationale and supporting KG paths.

Runs **in parallel** with `generate-search-strategy` — both depend only on `mechanisms`.

### `generate-search-strategy`

**Reads:** `patientProfile`, `mechanisms`, `searchStrategy` (previous attempt, if any)
**Writes:** `searchStrategy`, increments `attempts`
**Prompt:** `searchStrategyPrompt(profile, mechanisms, previousAttempt)`
**LLM call:** Yes.

Produces a structured `SearchStrategy`: query terms (condition + mechanism keywords) and filters (recruiting status, phase, country). On broaden iterations (when `searchStrategy` is non-null from a previous attempt), the prompt expands terms — drops specifics, adds synonyms, relaxes filters.

Does **not** include repurposing drug names; those are queried separately by `search-trials` to keep the prompts focused.

### `search-trials`

**Reads:** `searchStrategy`, `repurposingCandidates`
**Writes:** `candidates` (with `discoveredVia` and `repurposingDrugIds` provenance attached)
**Tools:** `clinicaltrials.searchClinicalTrials(strategy)` — clinicaltrials.gov v2 REST API

Issues **two queries** against CT.gov and unions the results (deduped by `nctId`):
1. The condition-based search from `searchStrategy`
2. A drug-intervention search for each repurposing candidate's drug name

Returns raw `TrialCandidate[]` (the unstructured eligibility text and structured metadata).

Each candidate carries provenance: `discoveredVia: ("strategy"|"repurposing")[]` and `repurposingDrugIds: string[]`. Strategy-only hits have `discoveredVia: ["strategy"]` and `repurposingDrugIds: []`. Repurposing channel hits carry the source `drug.id` values from `state.repurposingCandidates`; trials surfaced by both channels carry both labels. CT.gov calls retry on 429/503 with exponential backoff inside `tools/clinicaltrials.ts`; per-call failures are warn-logged and don't kill the channel.

### `pre-filter`

**Reads:** `patientProfile`, `candidates`
**Writes:** `candidates` (survivors), `candidateDrops` (audit trail)
**Prompt:** `preFilterPrompt(profile, candidate)` (Stage 2 only)
**LLM call:** Yes — per Stage-1 survivor, bounded concurrency 10.

Two-stage filter that cuts the candidate list from ~50–200 down to ~10–30 before the expensive `trial-eval` fan-out.

Stage 1 — deterministic gates (no LLM): drops on non-enrolling status, age mismatch, sex mismatch, or patient deceased.

Age is checked in two passes. First, a **categorical gate** on CT.gov's `stdAges` buckets (`CHILD`/`ADULT`/`OLDER_ADULT`): if the patient's bucket is disjoint from the trial's allowed buckets, drop with directional reason (above-range → `age-too-old`, below-range → `age-too-young`). This is resistant to numeric-parsing edge cases (e.g. `maximumAge: "48 Hours"` neonate trials). Second, a **numeric gate** on the parsed `minimumAgeYears`/`maximumAgeYears` for boundary cases within the same bucket. See `docs/ctgov-api-shape.md` for the field shapes.

Stage 2 — LLM-as-judge (Haiku, structured output): per Stage-1 survivor, the model returns `{keep, reason}`. The prompt instructs the model to keep when in doubt — false-negatives here are expensive (the trial vanishes from the run), false-positives are cheap (the downstream `trial-eval` eligibility node will catch them).

Every drop — Stage 1 or Stage 2 — produces an entry in `state.candidateDrops` with `{nctId, title, reason, stage, detail}` for audit display. The `detail` is the raw CT.gov string for numeric age drops (`"75 Years"`), the bucket list for categorical age drops (`"CHILD"`), and the overall status / sex eligibility / LLM reason for the other gates. LLM call failures are treated as keep (lenient) and do not produce a drop entry.

### `routeAfterPreFilter` (routing function, not a node)

**Reads:** `candidates`, `attempts`, `patientProfile`, `mechanisms`, `repurposingCandidates`
**Returns:** `"generate-search-strategy"` (broaden loop) **or** `Send[]` (fan out to trial-eval-subgraph)

This is the workflow's branching point. Two cases:

1. **Too few candidates and still under attempt cap** → return `"generate-search-strategy"`. The graph loops back; the next `generate-search-strategy` invocation sees the old `searchStrategy` and broadens.
2. **Otherwise** → return one `Send` per candidate, each invoking `trial-eval-subgraph` with the candidate, the patient profile, and the mechanisms/repurposing data. LangGraph runs them in parallel.

Constants: `MIN_CANDIDATES = 5`, `MAX_ATTEMPTS = 3`.

### `trial-eval-subgraph`

The per-trial evaluation. Each `Send` from `routeAfterPreFilter` invokes this subgraph with isolated state. Returns a single `TrialMatch` that gets concat'd into the parent's `matches` array. Detailed below in [Trial-eval subgraph](#trial-eval-subgraph-1).

### `rank-and-synthesize`

**Reads:** `patientProfile`, `matches` (the accumulated `TrialMatch[]`)
**Writes:** `matches` (re-ordered), `approvalRequest`
**Prompt:** `rankPrompt(profile, matches)`
**LLM call:** Yes.

Combines eligibility, mechanism plausibility, and literature support into a final priority ranking. Produces an `ApprovalRequest` payload summarizing the top matches with rationale, ready for human review.

### `human-approval`

**Reads:** `approvalRequest`
**Writes:** `matches` (if reviewer edits), `error` (if rejected)
**Mechanism:** Calls `interrupt(state.approvalRequest)`. The graph pauses indefinitely; LangGraph checkpoints state.

When the human resumes via `client.runs.create({ command: { resume: response } })`, the `interrupt()` call returns the `ApprovalResponse`:
- `action: "approve"` → no state change, proceeds to END
- `action: "edit"` → overwrites `matches` with the human's edits
- `action: "reject"` → clears `matches`, sets `error` with reviewer notes

This is the only node that blocks on external input. Resumption is a **fresh request**, so the pause itself doesn't hold a function/connection — the workflow naturally fits even on serverless platforms.

## Edges

| From | To | Type |
|---|---|---|
| `START` | `extract-patient-profile` | unconditional |
| `extract-patient-profile` | `identify-relevant-mechanisms` | unconditional |
| `identify-relevant-mechanisms` | `find-repurposing-candidates` | unconditional (parallel split) |
| `identify-relevant-mechanisms` | `generate-search-strategy` | unconditional (parallel split) |
| `find-repurposing-candidates` | `search-trials` | unconditional (implicit join with sibling) |
| `generate-search-strategy` | `search-trials` | unconditional (implicit join with sibling) |
| `search-trials` | `pre-filter` | unconditional |
| `pre-filter` | `generate-search-strategy` OR `trial-eval-subgraph × N` | conditional via `routeAfterPreFilter` |
| `trial-eval-subgraph` | `rank-and-synthesize` | unconditional (implicit join across all fan-out branches) |
| `rank-and-synthesize` | `human-approval` | unconditional |
| `human-approval` | `END` | unconditional |

Two implicit joins to note:
- **At `search-trials`**: waits for both `find-repurposing-candidates` and `generate-search-strategy` to complete.
- **At `rank-and-synthesize`**: waits for *all* N parallel `trial-eval-subgraph` branches. The `matches` concat reducer accumulates one `TrialMatch` per branch.

## Trial-eval subgraph

A self-contained `StateGraph` invoked once per candidate. Lives in [apps/agent/src/subgraphs/trial-eval/](../apps/agent/src/subgraphs/trial-eval/).

```
START → eligibility-check → mechanism-plausibility → literature-support ─┐
                                                          ↑              │
                                                          │              ↓
                                                          └── decide-if-more-evidence
                                                                         │ (proceed)
                                                                         ↓
                                                                   synthesize-match
                                                                         ↓
                                                                        END
```

### Subgraph state

| Field | Type | Notes |
|---|---|---|
| `patientProfile` | `PatientProfile` | Passed in via Send; immutable here |
| `candidate` | `TrialCandidate` | The one trial being evaluated |
| `mechanisms` | `Mechanism[]` | Passed in; immutable |
| `repurposingCandidates` | `RepurposingCandidate[]` | Passed in; immutable |
| `eligibility` | `EligibilityAssessment \| null` | Written by eligibility-check |
| `mechanismScore` | `number \| null` | Written by mechanism-plausibility |
| `mechanismRationale` | `string \| null` | Written by mechanism-plausibility |
| `literatureSupport` | `Citation[]` | Appended by literature-support (across cycle iterations) |
| `evidenceAttempts` | `number` | Incremented by literature-support; caps the cycle |
| `match` | `TrialMatch \| null` | Written by synthesize-match; returned to parent |

### `eligibility-check`

**Reads:** `patientProfile`, `candidate`
**Writes:** `eligibility`
**Prompt:** `eligibilityPrompt`
**LLM call:** Yes.

Per-criterion analysis: walks the trial's inclusion and exclusion criteria and decides `yes`/`no`/`unknown` for each against the patient profile, with cited evidence. Outputs an overall verdict (`eligible` / `likely_eligible` / `unclear` / `likely_ineligible` / `ineligible`).

### `mechanism-plausibility`

**Reads:** `patientProfile`, `candidate`, `mechanisms`
**Writes:** `mechanismScore` (0–100), `mechanismRationale`
**Tools:** `kg.pathBetween(intervention, condition, maxHops)` — finds graph paths from each trial intervention to each patient condition
**Prompt:** `mechanismPlausibilityPrompt`
**LLM call:** Yes.

Asks: does the trial's intervention plausibly address the patient's underlying mechanism? The LLM is given the trial's intervention(s), the patient's mechanisms (gene targets, pathways), and the actual KG paths between them. Returns a numeric plausibility score and a rationale.

### `literature-support`

**Reads:** `candidate`, `mechanisms`, `literatureSupport` (existing)
**Writes:** `literatureSupport` (replaced with new results), increments `evidenceAttempts`
**Tools:** `pubmed.searchPubMed(query, maxResults)`

Constructs a PubMed query from the trial's drug name(s), the patient's primary condition, and the identified mechanism. Returns matching `Citation[]`. On the second cycle iteration (`evidenceAttempts === 1`), the query is broadened — drops specificity to find more results.

### `decide-if-more-evidence` (routing function)

**Reads:** `literatureSupport`, `evidenceAttempts`
**Returns:** `"literature-support"` (cycle) or `"synthesize-match"` (proceed)

Cycles back to `literature-support` if both: fewer than `MIN_CITATIONS = 3` citations were found **and** `evidenceAttempts < MAX_EVIDENCE_ATTEMPTS = 2`. Otherwise proceeds to synthesis.

The cycle bound is mostly defensive — even if PubMed returns nothing on a broadened query, the workflow proceeds. The bound prevents pathological loops on obscure trials.

### `synthesize-match`

**Reads:** all subgraph state
**Writes:** `match`
**Prompt:** uses portions of `literatureSynthesisPrompt` and direct score combination

Combines `eligibility`, `mechanismScore`, `literatureSupport` into a single `TrialMatch`:
- Overall `score` (0–100): weighted combination
- `summary`: short human-readable
- `mechanismRationale`, `literatureSupport`, `repurposingRationale` (if the candidate's intervention matches one of the `repurposingCandidates`)
- `concerns`: red flags worth surfacing

The returned `match` flows back to the parent graph's `matches` array via the concat reducer.

## Concurrency model

- **Parallel branches** in the main graph (`identify-relevant-mechanisms` → both `find-repurposing-candidates` and `generate-search-strategy`) run concurrently. Each writes to a different state field; no conflict.
- **Fan-out** at `routeAfterPreFilter` dispatches up to N `Send`s to `trial-eval-subgraph`. LangGraph runs them in parallel up to its concurrency cap. Each subgraph has isolated state; only the `match` field returns.
- **Cycle** in `trial-eval-subgraph` (`literature-support` → `decide-if-more-evidence` → `literature-support`) is bounded by `evidenceAttempts < 2`.
- **Broaden loop** in the main graph (`pre-filter` → `generate-search-strategy`) is bounded by `attempts < 3`.

## Where to look for what

| You want to... | File |
|---|---|
| See the graph wiring | [apps/agent/src/graph.ts](../apps/agent/src/graph.ts) |
| See the state schema | [apps/agent/src/state.ts](../apps/agent/src/state.ts) |
| See a node body | [apps/agent/src/nodes/](../apps/agent/src/nodes/) |
| See the subgraph | [apps/agent/src/subgraphs/trial-eval/](../apps/agent/src/subgraphs/trial-eval/) |
| See a prompt | [apps/agent/src/prompts/](../apps/agent/src/prompts/) |
| See KG queries | [apps/agent/src/tools/kg.ts](../apps/agent/src/tools/kg.ts) |
| See CT.gov client | [apps/agent/src/tools/clinicaltrials.ts](../apps/agent/src/tools/clinicaltrials.ts) |
| See PubMed client | [apps/agent/src/tools/pubmed.ts](../apps/agent/src/tools/pubmed.ts) |
| See FHIR loader | [apps/agent/src/tools/patient-loader.ts](../apps/agent/src/tools/patient-loader.ts) |
| See shared domain types | [packages/shared/src/](../packages/shared/src/) |
