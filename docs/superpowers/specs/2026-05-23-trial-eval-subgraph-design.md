# Trial-eval subgraph: Design

**Date:** 2026-05-23
**Status:** Draft v1 (pending user review)
**Supersedes (partially):** [`2026-05-21-drug-eval-subgraph-design.md`](./2026-05-21-drug-eval-subgraph-design.md) — only the three *trial-eval enrichment* sections of that spec (eligibility safety step, mechanism-plausibility repurposing context, synthesize-match `repurposingRationale` population). The drug-eval v2 spec remains the source of truth for `find-repurposing-candidates`, `search-trials` provenance, and the `rank-and-synthesize` no-trial-leads appendix.

**Scope (in):**

- Full implementation of the per-trial evaluation subgraph at `apps/agent/src/subgraphs/trial-eval/` — currently all five nodes are stubs.
- Real implementations for the three tool gaps the subgraph needs:
  - `tools/pubmed.ts::searchPubMed` (currently `throw "not implemented"`).
  - `tools/kg.ts::pathBetween(fromId, toId, maxHops)` — variable-hop sample paths between two PrimeKG nodes.
  - `tools/kg.ts::findContraindicationsForDrugs(drugIds, diseaseIds)` — deterministic safety lookup.
  - `tools/kg.ts::resolveDrugByName(name)` — cached lowercased-name → drug `KGNode` lookup.
- Prompt files: `prompts/eligibility.ts`, `prompts/mechanism-plausibility.ts`, `prompts/literature-synthesis.ts` (extended to drive the synthesize-match LLM step), plus a new `prompts/match-synthesis.ts` if the synthesize step grows past what `literature-synthesis` is about.
- Schema extensions: `EligibilityAssessment` gains `safetyConcerns: SafetyConcern[]` (new schema). Subgraph state stays unchanged.
- Deterministic-formula score in `synthesize-match` with LLM-narrated `summary` and `concerns`.

**Scope (out):**

- Changes to the parent graph wiring or `routeAfterPreFilter` — fan-out cap stays `MAX_EVALUATIONS = 5`.
- `find-repurposing-candidates`, `search-trials`, `rank-and-synthesize` — covered by `2026-05-21-drug-eval-subgraph-design.md` (and already implemented for `find-repurposing-candidates` / `search-trials`).
- RxNorm / DrugBank crosswalk for drug-name resolution — keep the brittle lowercased-match approach for the prototype; flagged as a hardening target.
- Global LLM / Neo4j / PubMed token buckets — concurrency is bounded by `MAX_EVALUATIONS = 5` per run, which is already tight enough that no extra throttling is warranted (see *Concurrency*).
- Streaming intermediate LLM tokens out of the subgraph — the parent graph's `messages` stream already covers this; nothing subgraph-specific.

## Goal

Take one `TrialCandidate` (with `discoveredVia` provenance), the patient's `PatientProfile`, the kept `Mechanism[]`, and the `RepurposingCandidate[]`; produce one fully-scored `TrialMatch` that flows back to the parent graph via the `matches` concat reducer.

The match must:

1. **Reflect eligibility honestly.** Per-criterion verdicts (`yes`/`no`/`unknown`) against the trial's free-form inclusion/exclusion text, plus a deterministic PrimeKG safety check for trial-intervention vs. patient-condition contraindications.
2. **Score mechanism plausibility by the right source for the channel.** Repurposing-channel trials inherit the upstream TxGNN `predIndication` score (re-running an LLM-with-KG-paths check duplicates work TxGNN already did against the same drug-disease pair). Strategy-channel trials — surfaced by lexical CT.gov keyword match, with no biology vetted upstream — get the full `pathBetween` + LLM scoring pass. See *Channel-aware behavior* in `mechanism-plausibility` below.
3. **Cite literature.** Two PubMed attempts max; broaden on retry; union citations across attempts (dedupe by pmid).
4. **Compose a reproducible sort key, not a clinical verdict.** The `TrialMatch.score` is a single 0–100 number, but it's a *sort key* — the audit surface is the per-pillar fields already on `TrialMatch` (`eligibility.overall`, `mechanismScore`, `literatureSupport.length`, `concerns`). UI / `rank-and-synthesize` should present those pillars as first-class badges; the combined score is what we sort by, not the clinical judgment we hand to the reviewer. The formula gates on eligibility to prevent absurd orderings (an ineligible patient cannot score above 25 regardless of biology).
5. **Carry repurposing provenance through.** When `candidate.discoveredVia.includes("repurposing")`, populate `TrialMatch.repurposingRationale` from the source RepurposingCandidate.
6. **Never fail to produce a match.** A degraded match with `concerns` flagged is always better than no match — the parent's `matches` reducer is concat, and a missing element silently shrinks the count.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Subgraph state | Reuse the existing annotation in `subgraphs/trial-eval/state.ts` as-is | All fields already present; no additions needed. |
| `score` semantics | Sort key, not a clinical verdict. Per-pillar fields (`eligibility.overall`, `mechanismScore`, `literatureSupport.length`, `concerns`) are the audit surface. | A single number invites being read as a recommendation. The clinician needs the breakdown; ranking just needs a deterministic order. |
| Score composition | **Hybrid: formula computes `score`; LLM narrates `summary` + `concerns`** | Reproducible audit trail; tunable weights; LLM can't quietly drift the ranking. LLM still earns its keep on the narrative. |
| Score formula | Eligibility-gated weighted sum: `ineligible → 0`; `likely_ineligible → min(25, weightedSum)`; otherwise `weightedSum = 0.5·E + 0.3·M + 0.2·L` | A pure weighted sum lets `(ineligible=0, mechanism=80, literature=80)` score ~40 — looks "marginal," should be 0. The gate enforces that an unenrollable patient can't outrank an enrollable one regardless of biology. Eligibility shifts from "one of three weights" to "permission to be scored." |
| Eligibility sub-score | `eligible→100, likely_eligible→75, unclear→50, likely_ineligible→25, ineligible→0` (the latter two only feed the gate, not the weighted sum) | Maps the LLM's coarse 5-level enum to the 0–100 component score. |
| Mechanism sub-score | Channel-dependent: see *Channel-aware behavior* in `mechanism-plausibility`. Repurposing → TxGNN `predIndication × 100`. Strategy → LLM-produced 0–100. Null → 50 (neutral) with a concern. | The right source for each channel; avoids re-deriving TxGNN's signal with a thinner LLM-with-KG-paths pass. |
| Literature sub-score | `clamp(0, 100, citations.length × 25)` (so 4+ citations = 100) | Citation count is a noisy proxy for evidence weight; saturating at 4 keeps the literature component from dominating long-tail trials with shallow PubMed footprints. |
| Safety step | Deterministic Cypher `(drug)-[:contraindication]-(disease)` inside `eligibility-check`, **before** the LLM call | Belongs with eligibility, not a separate node. `side_effect` edges are not in the subset (dropped by `kg:build-subset`); the drug-eval v2 spec's reference to them is corrected here. |
| Drug-name resolution | Lowercased + formulation-suffix-stripped exact match against a one-time-cached PrimeKG drug-name index | Brittle but bounded; same trade-off the drug-eval v2 spec already accepted. Unresolved interventions are warn-logged, not errored. |
| `mechanism-plausibility` channel split | Repurposing-channel trials skip the LLM scoring pass and use TxGNN's `predIndication` directly; LLM is invoked only to narrate `mechanismRationale` from `supportingPaths`. Strategy-channel trials run the full `pathBetween` + LLM scoring pass. Both-channel trials (TxGNN score takes precedence; `pathBetween` augments the rationale prompt). | TxGNN already ranked the drug for the patient's MONDO upstream — re-scoring with 3 KG paths and an LLM duplicates work and risks signal drift between the two scoring sources. Strategy-channel matches are lexical CT.gov keyword hits with no upstream biology check, so they need the full pass. |
| `mechanism-plausibility` KG step (strategy channel only) | `kg.pathBetween(drugNodeId, diseaseNodeId, maxHops=3)` per (intervention, condition) pair, capped at `MAX_KG_PATHS_PER_PROMPT = 6` total | 3 hops covers `drug–[target]–gene–[associated with]–disease` and one extra step. The total cap protects prompt size; per-pair LIMIT in Cypher protects Neo4j cost. |
| Literature query construction | First attempt: `(${drug names join OR}) AND ${primary condition} AND ${mechanism keyword}`. Second attempt (broaden): drop the mechanism keyword. | One LLM-free query construction; mechanism keyword is the most likely false-negative. |
| Literature accumulation | Node-level dedupe-merge by `pmid` against the prior attempt; reducer stays replace | Replace reducer + node-level merge keeps the state contract simple while preventing a second-attempt-with-fewer-hits regression. |
| `synthesize-match` LLM call | Pass deterministic sub-scores + sub-rationales + the computed total; LLM returns `{ summary: string, concerns: string[] }` only | LLM doesn't touch the score; it narrates. Concerns array is structured (not free-text in summary) so the UI can render badges. |
| `repurposingRationale` source | Templated, populated in `synthesize-match` from the first `repurposingDrugIds[0]` entry's source RepurposingCandidate | No LLM call needed; the existing `RepurposingRationale` schema fields (`drugName`, `originalIndications`, `summary`) map directly from the candidate. |
| Per-subgraph LLM concurrency | None. Rely on `MAX_EVALUATIONS = 5` from `routeAfterPreFilter`. | 5 parallel subgraphs × 3 LLM calls peak = ≤15 in-flight; well below OpenRouter's per-key bucket on Haiku. Adding throttling here adds latency for no observable benefit. |
| Failure mode | Subgraph always returns a `TrialMatch` — even with degraded fields and concerns flagged | The parent `matches` reducer is concat; silently dropping a match would corrupt the count. Per-node failures fall back to neutral values + a concern, not `{error}`. |

## Architecture

```text
                START
                  │
                  ▼
        ┌─────────────────────┐
        │ eligibility-check   │
        │                     │
        │  1. Deterministic   │
        │     safety Cypher:  │
        │     (drug)-[:contra-│
        │     indication]-    │
        │     (disease)       │  → SafetyConcern[]
        │                     │
        │  2. LLM I/E         │
        │     per-criterion   │  → EligibilityAssessment
        │     analysis        │     (inclusion[], exclusion[],
        │                     │      overall, safetyConcerns)
        │                     │
        │  Writes:            │
        │     state.eligibility
        └─────────────────────┘
                  │
                  ▼
        ┌─────────────────────┐
        │ mechanism-          │
        │ plausibility        │
        │                     │
        │  channel-aware:     │
        │                     │
        │  Path A (repurpos): │
        │   1. score =        │
        │      TxGNN          │
        │      predIndication │
        │      × 100          │
        │   2. LLM narrates   │
        │      rationale from │
        │      supporting-    │
        │      Paths          │
        │                     │
        │  Path B (strategy): │
        │   1. KG pathBetween │
        │      per (interv,   │
        │      cond) pair     │
        │   2. LLM scores +   │
        │      narrates       │
        │                     │
        │  Both: Path A wins  │
        │                     │
        │  Writes:            │
        │     mechanismScore, │
        │     mechanismRationale
        └─────────────────────┘
                  │
                  ▼
        ┌─────────────────────┐ ◀─── (cycle from below)
        │ literature-support  │
        │                     │
        │  1. Build query     │
        │     - attempt 0:    │
        │       drug AND      │
        │       condition AND │
        │       mechanism kw  │
        │     - attempt 1     │
        │       (broaden):    │
        │       drug AND      │
        │       condition     │
        │                     │
        │  2. searchPubMed    │  → Citation[]
        │                     │
        │  3. Merge w/ prior  │
        │     attempt (dedupe │
        │     by pmid)        │
        │                     │
        │  Writes:            │
        │     literatureSupport,
        │     evidenceAttempts++
        └─────────────────────┘
                  │
                  ▼
        ┌─────────────────────┐
        │ decide-if-more-     │
        │ evidence            │
        │                     │
        │  citations < 3 AND  │
        │  attempts < 2 ?     │
        │                     │
        │   yes → loop ───────┘ (back to literature-support)
        │   no  → proceed
        └─────────────────────┘
                  │
                  ▼
        ┌─────────────────────┐
        │ synthesize-match    │
        │                     │
        │  1. weightedSum =   │
        │     0.5·E+0.3·M+    │
        │     0.2·L           │
        │                     │
        │  2. Eligibility     │
        │     gate:           │
        │     ineligible→0    │
        │     likely_inelig.  │
        │       →min(25, sum) │
        │     else→sum        │
        │                     │
        │  3. LLM narrates    │  → { summary, concerns }
        │     summary +       │
        │     concerns        │
        │                     │
        │  4. Lookup          │
        │     repurposing-    │
        │     Rationale via   │
        │     repurposingDrug-│
        │     Ids[0] (if any) │
        │                     │
        │  5. Assemble        │  → TrialMatch
        │     TrialMatch      │
        │                     │
        │  Writes:            │
        │     match           │
        └─────────────────────┘
                  │
                  ▼
                 END
                  │
                  ▼
        parent.matches.concat(match)
```

## Node-by-node detail

### `eligibility-check`

**Reads:** `patientProfile`, `candidate`, `repurposingCandidates` (for drug-id name resolution in the safety step — not strictly needed since interventions name-resolution is independent, but inexpensive).
**Writes:** `eligibility: EligibilityAssessment`.

**Step 1 — deterministic safety (Cypher):**

1. Resolve every `candidate.interventions[i]` to a PrimeKG drug node via `kg.resolveDrugByName`. Unresolved interventions are skipped (warn-logged once per run, not per intervention).
2. Resolve every active condition on the profile via the existing SNOMED→MONDO crosswalk (`tools/snomed-mondo.ts::resolveSnomedCondition`).
3. Single Cypher call: `kg.findContraindicationsForDrugs(resolvedDrugIds, resolvedDiseaseIds)` returns rows of `{ drugId, drugName, conditionId, conditionName, relation: "contraindication" }`. Map to `SafetyConcern[]`.

**Step 2 — LLM per-criterion analysis:**

- Prompt receives: patient summary (active conditions, active meds, prior treatments, demographics), full `eligibilityCriteriaText`, plus the structured `SafetyConcern[]` from Step 1 (so the LLM can downgrade `overall` if a contraindication is present).
- Structured output: `EligibilityAssessmentSchema`. Per-criterion `inclusion[]` and `exclusion[]` arrays carry `{ criterion, met: yes|no|unknown, evidence }`. `overall` is one of the 5 enum values. `safetyConcerns` is set to the Step 1 result regardless of LLM (it's deterministic).
- Truncate `eligibilityCriteriaText` to `ELIGIBILITY_FULL_CHARS = 8000` (matches the trial-eval / pre-filter asymmetry: pre-filter uses 4000 chars to be coarse; trial-eval doubles that — still bounds prompts, still catches the long tail).

**Error handling:**

- LLM call fails → `eligibility = { inclusion: [], exclusion: [], overall: "unclear", safetyConcerns: <step1 result> }`. Warn-log; subgraph proceeds (synthesize-match downgrades the score via the `unclear → 50` mapping).
- Cypher safety call fails → `safetyConcerns: []` with a warn-log; LLM step still runs.

**Schema work:**

- New `SafetyConcernSchema` in `packages/shared/src/eligibility.ts`:
  ```ts
  export const SafetyConcernSchema = z.object({
    drugId: z.string(),
    drugName: z.string(),
    conditionId: z.string(),
    conditionName: z.string(),
    relation: z.enum(["contraindication"]),
  });
  ```
  `relation` is a single-element enum on purpose — leaves room to add edges later without breaking consumers, but documents the current PrimeKG-subset reality (no `side_effect` edges).
- Extend `EligibilityAssessmentSchema`:
  ```ts
  safetyConcerns: z.array(SafetyConcernSchema).default([])
  ```

### `mechanism-plausibility`

**Reads:** `patientProfile`, `candidate`, `mechanisms`, `repurposingCandidates`.
**Writes:** `mechanismScore: number | null`, `mechanismRationale: string | null`.

**Channel-aware behavior.** This node behaves differently based on `candidate.discoveredVia`. The rationale is that the repurposing channel has already produced a TxGNN-scored drug-disease pair upstream; re-scoring it with `pathBetween` + an LLM duplicates work and risks signal drift between two scoring sources. The strategy channel is a lexical CT.gov keyword match with no upstream biology check, so it needs the full pass.

```
if candidate.discoveredVia.includes("repurposing"):
  → Path A: TxGNN-sourced score; LLM narrates only.
else:
  → Path B: pathBetween + LLM scoring (the original design).
```

For a trial surfaced by **both** channels, Path A wins (TxGNN's score is the authoritative source for that drug-disease pair). Path B's `pathBetween` results, if cheap to retrieve, augment the rationale prompt but do not produce a competing score.

---

**Path A — repurposing-channel (TxGNN score + LLM narrate):**

1. Look up the source RepurposingCandidate via `candidate.repurposingDrugIds[0]` against `state.repurposingCandidates`. If `repurposingDrugIds` has multiple entries (the same trial surfaced by multiple repurposing drugs), pick the one with the highest `predIndication`.
2. `mechanismScore = round(sourceRC.predIndication * 100)`. No LLM scoring pass.
3. LLM narrate-only call: prompt receives the trial summary, the source RepurposingCandidate's `supportingPaths` (TxGNN explanation), the patient's mechanisms (top gene + pathway names per mechanism), and the score. Returns `{ rationale: string }`.
   - `mechanismRationale` is the LLM's output. The prompt instructs: "TxGNN scored this drug at indication=X for the patient's disease. Explain that score using the supporting path; reference the patient's gene/pathway context."
4. If the source RepurposingCandidate has empty `supportingPaths` (TxGNN explanation missing for this drug-disease pair), fall back to a templated rationale: `"TxGNN predicted ${drug.name} for ${conditionName} (indication ${predIndication.toFixed(2)}); explanation path unavailable."` No LLM call.

**Path B — strategy-channel (KG + LLM score + narrate):**

1. KG path retrieval: for each resolved intervention drug × each `Mechanism` (one Mechanism per active patient condition, ≤5 mechanisms):
   - `kg.pathBetween(drug.id, mechanism.primekgDiseaseId, maxHops = 3)` — up to 5 paths per pair.
2. Truncate the global path list to `MAX_KG_PATHS_PER_PROMPT = 6` — round-robin across pairs so every mechanism gets a chance.
3. If no paths found across any pair, proceed with empty `KGPath[]`; LLM is told "no KG path found within 3 hops" explicitly.
4. LLM scoring call: prompt receives trial interventions + brief summary, ranked patient mechanisms (compact gene/pathway layout, mirroring `mechanismPrompt`), and the KG paths. Returns:
   ```ts
   MechanismPlausibilityJudgmentSchema = z.object({
     score: z.number().int().min(0).max(100),
     rationale: z.string(),
   })
   ```
5. Prompt instruction: score the *biological plausibility* of the trial's intervention(s) targeting this patient's mechanisms. 0 = no plausible mechanism / unrelated pathway. 50 = indirect support / weak path. 100 = direct, well-supported by the KG path.

---

> **Note on path provenance (Path A).** `RepurposingCandidate.supportingPaths` is already a `KGPath[]` in the exact shape this node's prompt consumes — `find-repurposing-candidates` populates it via `tools/txgnn.ts::lookupExplanation()`, and the TxGNN explanation data (`apps/agent/src/data/txgnn-explanations.json`) is committed in `KGPathSchema` form (types pre-normalized to `gene_protein`, edges already directional with PrimeKG-verbatim relation strings, uniformly `drug → gene → process → disease` 3-hop). This node does **not** re-query TxGNN, re-run Cypher to materialize the explanation, or transform the path shape. The drug-eval v2 spec's "Cypher metapath fallback for unexplained matches" remains deferred per that spec's lazy-fallback decision; in v1 of this design, an absent explanation triggers the templated-rationale fallback in step 4 above.

**Error handling:**

- Path A, LLM narrate fails → templated rationale (same as the missing-explanation fallback). Score is still TxGNN-sourced; the trial keeps its scoring signal.
- Path B, KG call fails → empty paths; LLM step still runs with "KG unavailable" note in prompt.
- Path B, LLM fails → `{ mechanismScore: null, mechanismRationale: null }`. Synthesize-match maps null → 50 with a concern.

### `literature-support`

**Reads:** `candidate`, `mechanisms`, `literatureSupport` (prior attempt), `evidenceAttempts`.
**Writes:** `literatureSupport: Citation[]` (replace reducer; node-level dedupe-merge with prior), `evidenceAttempts++`.

**Query construction:**

- Primary condition: `mechanisms[0].conditionName` if present, else the first active condition on the profile.
- Primary mechanism keyword (attempt 0 only): `mechanisms[0].pathways[0].name` if present, else first gene name.
- Drug terms: `candidate.interventions.slice(0, 3)` (some trials list combo arms with many interventions; cap to keep query lean).
- Build query:
  - Attempt 0: `(<drug1> OR <drug2> OR <drug3>) AND <condition> AND <mechanism>`
  - Attempt 1: `(<drug1> OR <drug2> OR <drug3>) AND <condition>` — drop mechanism keyword
- `searchPubMed(query, maxResults = 10)` → `Citation[]`.

**Merge:**

- After the call: `merged = dedupeByPmid([...state.literatureSupport, ...newCitations])`. Keeps anything found on attempt 0 even if attempt 1 finds fewer (e.g. broadening misses a niche citation).
- `evidenceAttempts++` regardless of success.

**Error handling:**

- PubMed call fails → return `{ literatureSupport: state.literatureSupport, evidenceAttempts: state.evidenceAttempts + 1 }`. Warn-log. The cycle bound still applies, so we don't loop forever.

### `decide-if-more-evidence` (unchanged from existing stub)

Existing logic is correct: cycle while `literatureSupport.length < MIN_CITATIONS (3) && evidenceAttempts < MAX_EVIDENCE_ATTEMPTS (2)`. No changes.

### `synthesize-match`

**Reads:** all subgraph state.
**Writes:** `match: TrialMatch`.

**Step 1 — deterministic score:**

```
eligibilityScore = {
  eligible: 100,
  likely_eligible: 75,
  unclear: 50,
  likely_ineligible: 25,
  ineligible: 0,
}[state.eligibility.overall]

mechanismScore = state.mechanismScore ?? 50

literatureScore = clamp(0, 100, state.literatureSupport.length * 25)

weightedSum = round(
  0.5 * eligibilityScore +
  0.3 * mechanismScore +
  0.2 * literatureScore
)

// Eligibility gate: an unenrollable patient cannot outrank an enrollable
// one regardless of biology / literature.
if (state.eligibility.overall === "ineligible") {
  score = 0
} else if (state.eligibility.overall === "likely_ineligible") {
  score = Math.min(25, weightedSum)
} else {
  score = weightedSum
}
```

Weights and the literature saturation point are named constants in the node module (e.g. `WEIGHT_ELIGIBILITY = 0.5`, `LIKELY_INELIGIBLE_CAP = 25`) — easy to tune.

**Why the gate.** A pure weighted sum makes `(eligibility=ineligible=0, mechanism=80, literature=80)` score `0 + 24 + 16 = 40`, which reads as "marginal." That's wrong: an ineligible patient can't enroll, full stop, so the trial should not outrank an `eligible` candidate with weaker biology. The gate enforces that — eligibility is *permission to be scored*, not just one of three weights. This is also why the `score` field is documented as a sort key, not a clinical verdict: clinicians read `eligibility.overall`, `mechanismScore`, and `concerns` directly off the `TrialMatch`; the score just orders the list.

**Step 2 — LLM narrate:**

- Prompt receives:
  - patient summary
  - trial summary
  - all three sub-scores + the total
  - eligibility verdict (`overall`) + first 3 "no" verdicts on inclusion criteria + first 3 "yes" verdicts on exclusion criteria + safetyConcerns
  - mechanism rationale (from `state.mechanismRationale`)
  - citation count + first 3 citation titles
- Structured output:
  ```ts
  MatchNarrationSchema = z.object({
    summary: z.string(),
    concerns: z.array(z.string()),
  })
  ```
- Prompt instructs: write a 2–3 sentence summary describing the match; populate `concerns[]` with explicit red flags (contraindication present, inclusion criteria not met, no mechanism path, no literature support).

**Step 3 — repurposingRationale:**

```ts
let repurposingRationale: RepurposingRationale | null = null;
const repurposingDrugId = candidate.repurposingDrugIds[0];
if (repurposingDrugId) {
  const sourceRC = repurposingCandidates.find(rc => rc.drug.id === repurposingDrugId);
  if (sourceRC) {
    repurposingRationale = {
      drugName: sourceRC.drug.name,
      originalIndications: sourceRC.originalIndications,
      summary: `${sourceRC.drug.name} is approved for ${sourceRC.originalIndications.join(", ")}; ` +
               `TxGNN predicted it for ${sourceRC.originalIndications[0]} (indication ${sourceRC.predIndication?.toFixed(2) ?? "n/a"}).`,
    };
  }
}
```

Templated, no LLM call. The narrate LLM in Step 2 can incorporate this into the overall `summary` since the trial summary block tells it the candidate came from the repurposing channel.

**Step 4 — assemble:**

```ts
const match: TrialMatch = {
  ...candidate,                              // all TrialCandidate fields
  score,
  summary,                                   // from Step 2
  eligibility: state.eligibility,            // includes safetyConcerns
  mechanismScore,
  mechanismRationale: state.mechanismRationale ?? "Mechanism evaluation unavailable",
  literatureSupport: state.literatureSupport,
  repurposingRationale,                      // from Step 3
  concerns,                                  // from Step 2
};
```

**Error handling:**

- LLM narrate fails → fallback `summary` = `"${candidate.title}: eligibility=${overall}, mechanismScore=${mechanismScore}, ${literatureSupport.length} citation(s)."`. Concerns derived deterministically from the sub-results (e.g. "safety concern: contraindication with X"). The deterministic score still computes; the match still flows back. Warn-log.

## Concurrency

Per subgraph invocation, the call shape is:

| Step | LLM calls | Neo4j calls | PubMed calls |
|---|---|---|---|
| `eligibility-check` | 1 | 1 | 0 |
| `mechanism-plausibility` | 1 | up to 5 × 3 = 15 (per intervention × per mechanism, parallel) | 0 |
| `literature-support` (×2 max) | 0 | 0 | 1 (×2 max) |
| `synthesize-match` | 1 | 0 | 0 |
| **Per-subgraph total** | **3** | **up to ~16** | **up to 2** |

Parent graph fans out up to `MAX_EVALUATIONS = 5` subgraphs in parallel. Peak load is therefore:

- **LLM:** 15 in-flight calls (5 subgraphs × 3 stages, though the stages run sequentially within a subgraph — so actual peak is 5). Haiku via OpenRouter handles this without throttling.
- **Neo4j:** 80 in-flight queries at peak (5 × 16). `neo4j-driver`'s default connection pool is 100 — fits.
- **PubMed:** 5 in-flight (one per subgraph). With `PUBMED_API_KEY` set (10 req/sec) this is fine; without the key (3 req/sec) we'd risk the bucket. Mitigation: literature-support already serializes the two attempts within a subgraph, so the practical PubMed rate is ≤5 req/2s. Within budget.

No per-subgraph token bucket. If we observe 429s in production we add one then.

## State shape changes

`apps/agent/src/subgraphs/trial-eval/state.ts`: **no changes**. Existing annotation already carries every field this design needs.

`packages/shared/src/eligibility.ts`:

```ts
// New
export const SafetyConcernSchema = z.object({
  drugId: z.string(),
  drugName: z.string(),
  conditionId: z.string(),
  conditionName: z.string(),
  relation: z.enum(["contraindication"]),
});
export type SafetyConcern = z.infer<typeof SafetyConcernSchema>;

// Extended (new field)
export const EligibilityAssessmentSchema = z.object({
  inclusion: z.array(CriterionAssessmentSchema),
  exclusion: z.array(CriterionAssessmentSchema),
  overall: OverallEligibilitySchema,
  safetyConcerns: z.array(SafetyConcernSchema).default([]),
});
```

`packages/shared/src/state.ts`, `packages/shared/src/trial.ts`: **no changes**. `TrialMatch.eligibility` already references `EligibilityAssessmentSchema`; the extension flows through.

The compile-time `_AgentStateMatchesGraphState` guard in `apps/agent/src/state.ts` continues to hold because the agent-level `matches: TrialMatch[]` already pulls from the shared schema.

## Tool implementations

### `tools/pubmed.ts::searchPubMed(query, maxResults = 10)`

Two-step E-utilities call:

1. **`esearch.fcgi`** — find PMIDs:
   `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<encoded>&retmax=<n>&retmode=json[&api_key=<key>]`
   Response: `{ esearchresult: { idlist: string[] } }`.
2. **`esummary.fcgi`** — title, authors, year for each PMID:
   `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<csv>&retmode=json[&api_key=<key>]`
   Response: `{ result: { <pmid>: { title, pubdate, authors[], ... } } }`.

Skip abstracts for v1 (efetch returns XML and bloats responses). `CitationSchema.abstractExcerpt` stays optional and we leave it undefined; surface the title-and-citation footprint and call it good. Revisit if literature-support's LLM consumers turn out to need abstracts.

Build `Citation`:

```ts
{
  pmid,
  title,
  year: parseInt(pubdate.slice(0, 4)) || undefined,
  url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
}
```

**Retry / rate limits:** identical pattern to `tools/clinicaltrials.ts` — retry 429/503 with exponential backoff (3 attempts, 1s/2s/4s), honor `Retry-After`. Read `PUBMED_API_KEY` from env if present (raises the per-IP limit from 3 to 10 req/sec).

### `tools/kg.ts::pathBetween(fromId, toId, maxHops = 3, pathLimit = 5)`

```cypher
MATCH p = (a:Node {id: $fromId})-[*1..$maxHops]-(b:Node {id: $toId})
RETURN p
LIMIT $pathLimit
```

Notes:

- Variable-length paths explode quickly; `maxHops = 3` and `LIMIT 5` keep it bounded. PrimeKG's PPI density on cancer pathways will still make this expensive; if we see slow queries, add a per-hop type filter (e.g. exclude `ppi`).
- Wrap `maxHops` and `pathLimit` with `neo4j.int(...)` (the LIMIT FLOAT trap).
- Return `KGPath[]` — map each `path.nodes` to `KGNode` via `normalizeNodeType`, each `path.relationships` to `KGEdge` with `{source, target, relation: type(r)}`.
- Empty result is normal; return `[]` (no throw).

### `tools/kg.ts::findContraindicationsForDrugs(drugIds, diseaseIds)`

```cypher
MATCH (d:Node {type: 'drug'})-[:`contraindication`]-(c:Node {type: 'disease'})
WHERE d.id IN $drugIds AND c.id IN $diseaseIds
RETURN DISTINCT d.id AS drugId, d.name AS drugName,
                c.id AS conditionId, c.name AS conditionName
```

Returns `SafetyConcern[]` (with `relation: "contraindication"` filled in client-side). `DISTINCT` because the undirected match yields duplicate rows (per `docs/primekg-querying.md`).

### `tools/kg.ts::resolveDrugByName(name)`

- First call: build a one-time-cached map `Map<normalizedName, KGNode>` via:
  ```cypher
  MATCH (d:Node {type: 'drug'})
  RETURN d.id AS id, d.name AS name
  ```
  (~8K rows; one-time cost; cached on module state alongside the driver singleton).
- Normalize input: lowercase, strip trailing dose/formulation tokens via a regex like `/\s+\d+\s*(mg|mcg|ml|g)?\s*(tablet|capsule|injection|...)?$/i`.
- Lookup. Cache hit → `KGNode`; miss → `null`.
- Test seam: a `setDrugNameIndex` exporter for unit tests, mirroring `setDriver`.

Brittleness is acknowledged. RxNorm/DrugBank crosswalk is the hardening path; not in v1 scope.

## Error model summary

| Failure | Handling |
|---|---|
| Drug-name unresolvable | Skip that intervention in safety + pathBetween; warn-log once per subgraph |
| Disease MONDO unresolvable | Skip that condition in safety + pathBetween; already warn-logged upstream by `identify-relevant-mechanisms` |
| Cypher throws (driver/network) | Empty result for that node's KG component; LLM step still runs; warn-log |
| LLM API failure in `eligibility-check` | `eligibility = { ..., overall: "unclear" }`; subgraph proceeds with neutral score component |
| LLM API failure in `mechanism-plausibility` (Path A: narrate-only) | Score stays at TxGNN-sourced value; rationale falls back to templated string; subgraph proceeds with full scoring signal |
| LLM API failure in `mechanism-plausibility` (Path B: scoring) | `mechanismScore = null` → maps to 50 + adds "mechanism evaluation unavailable" concern |
| LLM API failure in `synthesize-match` | Templated summary + deterministic concerns; deterministic score still computes; match still flows back |
| PubMed call throws | `literatureSupport` unchanged for this attempt; `evidenceAttempts++`; cycle bound still applies |
| Both literature attempts return 0 citations | `literatureScore = 0`; `concerns` includes "no PubMed evidence found"; not an error |
| TxGNN data unavailable (parent already errored) | Parent graph's `find-repurposing-candidates` already returned `{error}`; this subgraph never runs |

**No node returns `{error}` at the subgraph level.** The subgraph contract is "always return a `TrialMatch`" — degraded matches with `concerns` flagged are strictly more useful than silent drops, because the `matches` concat reducer can't distinguish "fan-out N branches each returned 1 match" from "fan-out N branches but K of them returned 0 matches."

## Risks and open items

1. **Drug-name → PrimeKG resolution is brittle.** CT.gov interventions are free-form strings; salt forms, brand names, combo arms ("olaparib + bevacizumab") will miss our normalize-and-exact-match approach. Acceptable for prototype; flag for RxNorm/DrugBank crosswalk later. Already flagged in drug-eval v2.
2. **PrimeKG `contraindication` coverage is not exhaustive.** A drug being absent from contraindication edges doesn't mean it's safe for the patient — it means PrimeKG doesn't have data on that pair. The safety step is a positive-signal filter (when present, surface it); absence is not endorsement. Document this in the UI badge for `safetyConcerns`.
3. **`pathBetween` with 3 hops on dense oncology nodes will be slow.** PrimeKG cancer diseases have hundreds of associated genes and thousands of PPI edges. `LIMIT 5` bounds path return but the planner still walks the neighborhood. If we see >2s queries on EGFR / TP53 / BRCA1-class diseases, restrict the per-hop relationship types (exclude `ppi`) or precompute drug-disease shortest paths offline.
4. **LLM scoring drift on Path B `mechanism-plausibility`.** Strategy-channel trials get their `mechanismScore` from an LLM call; runs are not reproducible across model versions. Path A is immune (TxGNN is deterministic given the same dump). Eligibility is also LLM-influenced (the `overall` enum). Track score distributions across patients on the first 10 runs and flag if Haiku's calibration shifts meaningfully on model bumps.
9. **Channel-split scoring asymmetry.** Path A's score reflects TxGNN's confidence on a drug-disease pair (population-level). Path B's score reflects an LLM's read of 3-hop KG paths (also population-level, but filtered through prompt phrasing). The two are not strictly commensurable — a TxGNN 0.85 doesn't mean the same thing as an LLM "85." Mitigation: both go into the same weighted sum and the same UI pillar; calibration is empirical, not formal. Watch for ranking inversions where a Path A score 70 sits above a Path B score 85 (or vice versa) for trials the clinician judges equivalent; re-tune if it happens systematically.
5. **PubMed query construction is hand-crafted, not LLM-generated.** Trade is reproducibility vs. recall — a slightly more clever query (synonyms, MeSH terms, year limits) might surface better citations, but we don't want a per-trial LLM call in the literature step. Revisit if first runs show consistently empty literature on common drugs.
6. **`MAX_KG_PATHS_PER_PROMPT = 6` may be too tight on multi-intervention combo trials.** Some oncology trials list 4 interventions; with 5 mechanisms that's 20 pairs and we only show 6 paths. Mitigation: the round-robin selection ensures every mechanism gets at least one path; LLM is told the cap is informational, not exhaustive.
7. **No abstract retrieval in v1.** `Citation.abstractExcerpt` will be undefined; `synthesize-match`'s prompt only sees titles. If the LLM consistently writes "no abstract context available" in its summaries, add the efetch step.
8. **Score weights are guesses.** 0.5/0.3/0.2 — eyeball the first 10 runs; if the rank order disagrees with clinician intuition systematically, reweight. Constants are named for easy tuning.

## Testing

Following `docs/codebase-conventions.md`:

- **`subgraphs/trial-eval/nodes/eligibility-check.test.ts`** — fixtures: patient with a known contraindication-edge condition, trial with an intervention that triggers it. Mock `llm` and `kg.findContraindicationsForDrugs`. Assert: safetyConcerns populated; LLM prompt includes the concern; assessment passed through.
- **`subgraphs/trial-eval/nodes/mechanism-plausibility.test.ts`** — cover both channel paths:
  - Path A (repurposing-only): assert `mechanismScore = round(predIndication × 100)` (no LLM scoring call); LLM narrate-only invoked with `supportingPaths`; missing `supportingPaths` triggers templated rationale (no LLM call).
  - Path B (strategy-only): mock `kg.pathBetween`; assert per-pair paths retrieved, capped at `MAX_KG_PATHS_PER_PROMPT`; LLM scoring mock returns `{score, rationale}`; both written to state.
  - Both-channel: assert Path A taken (TxGNN score wins); strategy-channel `pathBetween` not called or only used to augment rationale.
- **`subgraphs/trial-eval/nodes/literature-support.test.ts`** — mock `searchPubMed`. Cases: (a) attempt 0 returns 4 citations → no broaden; (b) attempt 0 returns 1 → broaden, attempt 1 returns 2, merged set has 3 (deduped by pmid); (c) PubMed throws → state unchanged, attempts++.
- **`subgraphs/trial-eval/nodes/decide-if-more-evidence.test.ts`** — trivial; covered. (Already passing because the routing fn was implemented in the skeleton.)
- **`subgraphs/trial-eval/nodes/synthesize-match.test.ts`** — fixtures covering the score formula + eligibility gate:
  - (a) `eligible` + mechanism 80 + 3 citations → weightedSum = `0.5·100 + 0.3·80 + 0.2·75 = 89` → score 89 (no gate).
  - (b) `likely_ineligible` + null mechanism + 0 citations → weightedSum = `0.5·25 + 0.3·50 + 0.2·0 = 27.5` → 28; gate caps at 25 → score 25.
  - (c) `ineligible` + mechanism 90 + 4 citations → weightedSum = `0.5·0 + 0.3·90 + 0.2·100 = 47` → gate forces score 0; concerns include "patient ineligible".
  - (d) Repurposing-channel candidate → `repurposingRationale` populated from `state.repurposingCandidates`; templated `summary` matches the spec.
  - LLM narrate mocked in all cases.
- **`tools/pubmed.test.ts`** — mock `fetch`. Assert: esearch → esummary flow, Citation shape, retry on 429, optional API key in query.
- **`tools/kg.test.ts`** (existing file) — add tests for `pathBetween` and `findContraindicationsForDrugs` via in-memory driver substitution (existing `setDriver` test seam).

No live PubMed / Neo4j / LLM calls in unit tests. Integration smoke (manual, not gated): run the full graph against archetype patient 0 and inspect the resulting `TrialMatch[]` for one repurposing-channel match and one strategy-only match — verify `repurposingRationale` populated correctly on the former, null on the latter.

## Implementation order (suggested)

1. **Schema** — `SafetyConcernSchema` + extend `EligibilityAssessmentSchema`. Run typecheck; the compile-time guards catch any missed call sites.
2. **Tools** — `pubmed.searchPubMed`, `kg.pathBetween`, `kg.findContraindicationsForDrugs`, `kg.resolveDrugByName`. Each with its co-located test.
3. **Prompts** — `eligibility.ts`, `mechanism-plausibility.ts`, plus a new prompt module for synthesize narration (keep `literature-synthesis.ts` for any inline-citations work later; don't conflate).
4. **Nodes**, in order:
   1. `eligibility-check`
   2. `mechanism-plausibility`
   3. `literature-support`
   4. `synthesize-match`

   Co-located tests per node.
5. **Manual smoke run** against an archetype patient; eyeball score weights and concerns.
6. **Update `docs/topology.md`** trial-eval subgraph section with the implemented shape (the existing description matches the design, but the score formula and safety step belong in topology).
