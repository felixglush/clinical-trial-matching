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
| `eligibility` | `EligibilityAssessment \| null` | Written by eligibility-check; carries `safetyConcerns: SafetyConcern[]` from the deterministic Cypher step |
| `mechanismScore` | `number \| null` | Written by mechanism-plausibility |
| `mechanismRationale` | `string \| null` | Written by mechanism-plausibility |
| `literatureSupport` | `Citation[]` | Appended by literature-support (across cycle iterations) |
| `evidenceAttempts` | `number` | Incremented by literature-support; caps the cycle |
| `match` | `TrialMatch \| null` | Written by synthesize-match; returned to parent |

### `eligibility-check`

**Reads:** `patientProfile`, `candidate`, `repurposingCandidates`
**Writes:** `eligibility`
**Tools:** `kg.resolveDrugByName`, `kg.findContraindicationsForDrugs` (Step 1); `llm` (Step 2)
**Prompt:** `eligibilityPrompt`
**LLM call:** Yes — in Step 2 only.

Runs two steps. **Step 1 — deterministic safety lookup (no LLM).** Resolve each `candidate.interventions[*]` to a PrimeKG drug node via `kg.resolveDrugByName` (lowercased + formulation-suffix-stripped exact match against a one-time-cached drug-name index; unresolved interventions are skipped with a single warn-log). Resolve each active patient condition via the SNOMED→MONDO crosswalk. Then call `kg.findContraindicationsForDrugs(drugIds, diseaseIds)` — a single Cypher query against `(:drug)-[:contraindication]-(:disease)` returning `SafetyConcern[]`. The PrimeKG subset has no `side_effect` edges, so contraindication is the only `relation` value today (the schema enum leaves room to add others).

**Step 2 — LLM per-criterion analysis.** Walks the trial's inclusion and exclusion criteria and decides `yes`/`no`/`unknown` for each against the patient profile, with cited evidence. The prompt also receives the `SafetyConcern[]` from Step 1 so the LLM can downgrade `overall` when a contraindication is present. Outputs an overall verdict (`eligible` / `likely_eligible` / `unclear` / `likely_ineligible` / `ineligible`). `eligibilityCriteriaText` is truncated to 8000 chars (twice the pre-filter budget — bounds the prompt while still catching the long tail).

`safetyConcerns` is always the Step 1 result regardless of what the LLM returns (it's deterministic data, not a judgment). Step 1 Cypher failure → `safetyConcerns: []` with a warn-log; the LLM step still runs. Step 2 LLM failure → `overall: "unclear"` with empty inclusion/exclusion arrays; synthesize-match maps `unclear → 50` for the formula.

### `mechanism-plausibility`

**Reads:** `patientProfile`, `candidate`, `mechanisms`, `repurposingCandidates`
**Writes:** `mechanismScore` (0–100), `mechanismRationale`
**Tools:** `kg.resolveDrugByName`, `kg.pathBetween(drugId, diseaseId, maxHops=3)` (Path B only)
**Prompt:** `mechanismPlausibilityPrompt` (Path B only)
**LLM call:** Conditional — Path B only.

Channel-aware. The repurposing channel already produced a TxGNN-scored drug-disease pair upstream; re-scoring it with `pathBetween` + an LLM duplicates work and risks signal drift. The strategy channel is a lexical CT.gov keyword match with no upstream biology vetting, so it needs the full pass.

**Path A — repurposing channel (no LLM call).** Triggered when `candidate.discoveredVia.includes("repurposing")`. Looks up the source `RepurposingCandidate` via `candidate.repurposingDrugIds[0]` (when multiple repurposing drugs surfaced the same trial, picks the entry with the highest `predIndication`). Then:

- `mechanismScore = round(sourceRC.predIndication * 100)`.
- `mechanismRationale` is templated from `sourceRC.supportingPaths[0]` — the TxGNN explanation path committed as data on the candidate. The template names the drug, the original indication(s), the `predIndication` value, and the intermediate node names from the supporting path (e.g. `"via EGFR / ERBB signaling pathway"`). Missing `supportingPaths` falls back to `"no TxGNN explanation path available"`; score is still TxGNN-sourced.

No LLM call: `find-repurposing-candidates` already produced the canonical one-line rationale, and `synthesize-match`'s narrate LLM composes the user-facing `summary` from all the structured signals. A fourth generator here would re-narrate content the synthesize step already covers.

**Path B — strategy channel (LLM + KG).** Triggered when the candidate has no repurposing provenance. For each resolved intervention × each patient mechanism (one per active condition, ≤5), calls `kg.pathBetween(drugId, mechanism.primekgDiseaseId, maxHops=3)` returning up to 5 paths per pair. The global path list is truncated round-robin to `MAX_KG_PATHS_PER_PROMPT = 6` so every mechanism gets a chance. The LLM then receives the trial's intervention(s), the ranked mechanisms (compact gene/pathway layout), and the KG paths; returns `MechanismPlausibilityJudgmentSchema = { score: 0–100, rationale: string }`. Scoring rubric in the prompt: 0 = no plausible mechanism, 50 = indirect / weak path, 100 = direct and well-supported.

**Both channels.** If a trial was surfaced by both repurposing and strategy, Path A wins — TxGNN is the authoritative score for that drug-disease pair.

**Error handling.** Path A cannot fail in the LLM sense (no LLM call). Path B KG-call failure → empty paths, LLM still runs with a "KG unavailable" note. Path B LLM failure → `{ mechanismScore: null, mechanismRationale: null }`; synthesize-match maps null → 50 (neutral) and adds a concern.

### `literature-support`

**Reads:** `candidate`, `mechanisms`, `literatureSupport` (prior attempt), `evidenceAttempts`
**Writes:** `literatureSupport` (replace reducer; node-level dedupe-merge with prior), increments `evidenceAttempts`
**Tools:** `pubmed.searchPubMed(query, maxResults = 10)`

Constructs a PubMed query from the trial's drug name(s) (`candidate.interventions.slice(0, 3)`), the patient's primary condition (`mechanisms[0].conditionName` or first active condition), and the primary mechanism keyword (`mechanisms[0].pathways[0].name`, falling back to the first gene name). Attempt 0: `(drug1 OR drug2 OR drug3) AND <condition> AND <mechanism>`. Attempt 1 (broaden): drops the mechanism keyword — the most likely false-negative term.

After each call, the node performs a `dedupeByPmid([...prior, ...new])` merge before writing back. The replace reducer plus node-level merge keeps the state contract simple while preventing a second-attempt-with-fewer-hits regression (a broadened query that misses a niche citation can't shrink the set).

Citations are **artifacts only** — they flow through to `TrialMatch.literatureSupport` for the clinician brief and the `synthesize-match` narrate prompt sees the first 3 titles when writing `summary`, but citation count does **not** feed the score formula. Counting CT.gov drug-condition citations measures "has this combo ever been studied" (yes — that's why CT.gov has the trial), not "is the evidence relevant to this patient." The pillars that score are eligibility and mechanism; literature accompanies the match as supporting evidence the reviewer can follow.

PubMed failure → state unchanged for this attempt, `evidenceAttempts++` regardless so the cycle bound still applies.

### `decide-if-more-evidence` (routing function)

**Reads:** `literatureSupport`, `evidenceAttempts`
**Returns:** `"literature-support"` (cycle) or `"synthesize-match"` (proceed)

Cycles back to `literature-support` if both: fewer than `MIN_CITATIONS = 3` citations were found **and** `evidenceAttempts < MAX_EVIDENCE_ATTEMPTS = 2`. Otherwise proceeds to synthesis.

The cycle bound is mostly defensive — even if PubMed returns nothing on a broadened query, the workflow proceeds. The bound prevents pathological loops on obscure trials.

### `synthesize-match`

**Reads:** all subgraph state
**Writes:** `match`
**Prompt:** `matchSynthesisPrompt` (narrate only)
**LLM call:** Yes — narration only, never touches the score.

**Score is deterministic.** The LLM narrates `summary` and `concerns`; the number is computed from the sub-pillars by an eligibility-gated two-pillar weighted sum:

```
eligibilityScore = { eligible: 100, likely_eligible: 75, unclear: 50,
                     likely_ineligible: 25, ineligible: 0 }[overall]
mechanismScore   = state.mechanismScore ?? 50          // null → neutral
weightedSum      = round(0.6 · eligibilityScore + 0.4 · mechanismScore)

if (overall === "ineligible")        score = 0
else if (overall === "likely_ineligible") score = min(25, weightedSum)
else                                 score = weightedSum
```

Weights are named constants in the node (`WEIGHT_ELIGIBILITY = 0.6`, `WEIGHT_MECHANISM = 0.4`, `LIKELY_INELIGIBLE_CAP = 25`) — easy to tune.

The eligibility gate enforces that an unenrollable patient can't outrank an enrollable one regardless of biology. Without it, `(ineligible, mechanism=80)` would score 32 — reading as "marginal," which is wrong: the patient can't enroll. The gate makes eligibility *permission to be scored*, not just one of two weights. `score` is therefore documented as a sort key, not a clinical verdict — the audit surface is the per-pillar fields on `TrialMatch` (`eligibility.overall`, `mechanismScore`, `literatureSupport`, `concerns`); clinicians read those, the score just orders the list.

**Literature is not a formula input.** Citation count saturates fast across CT.gov drug-condition pairs (see `literature-support` above). The narrate LLM does see citation titles when writing `summary` — and `literatureSupport` flows onto the final `TrialMatch` — but the number doesn't move the score.

**LLM narrate step.** The prompt receives a patient summary, trial summary, the two sub-scores + total, eligibility verdict + first 3 `no` inclusion verdicts + first 3 `yes` exclusion verdicts + `safetyConcerns`, the mechanism rationale, and the citation count + first 3 titles. Structured output `MatchNarrationSchema = { summary: string, concerns: string[] }` — a 2–3 sentence `summary` and an explicit `concerns[]` array (contraindication present, inclusion criteria not met, no mechanism path, no PubMed evidence) so the UI can render badges.

**`repurposingRationale`** is templated, not LLM-generated: when `candidate.repurposingDrugIds[0]` exists, look up the source `RepurposingCandidate` and populate `{ drugName, originalIndications, summary }` directly from its fields.

**Assembly.** `match` spreads the `TrialCandidate` fields then layers in `score`, `summary`, `eligibility` (with `safetyConcerns`), `mechanismScore`, `mechanismRationale`, `literatureSupport`, `repurposingRationale`, and `concerns`.

**LLM narrate failure** → templated fallback `summary` referencing the candidate title + sub-scores + citation count; `concerns` derived deterministically (e.g. "safety concern: contraindication with X"); the deterministic score still computes; the match still flows back. The subgraph contract is *always return a `TrialMatch`* — the parent `matches` concat reducer can't distinguish a fan-out that returned 0 matches from one that returned N, so a degraded match with concerns is strictly more useful than a silent drop.

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
| See the trial-eval subgraph spec | [docs/superpowers/specs/2026-05-23-trial-eval-subgraph-design.md](./superpowers/specs/2026-05-23-trial-eval-subgraph-design.md) |
| See a prompt | [apps/agent/src/prompts/](../apps/agent/src/prompts/) |
| See KG queries | [apps/agent/src/tools/kg.ts](../apps/agent/src/tools/kg.ts) |
| See CT.gov client | [apps/agent/src/tools/clinicaltrials.ts](../apps/agent/src/tools/clinicaltrials.ts) |
| See PubMed client | [apps/agent/src/tools/pubmed.ts](../apps/agent/src/tools/pubmed.ts) |
| See FHIR loader | [apps/agent/src/tools/patient-loader.ts](../apps/agent/src/tools/patient-loader.ts) |
| See shared domain types | [packages/shared/src/](../packages/shared/src/) |
