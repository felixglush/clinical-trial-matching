# Mechanism counter-evidence: replace PubMed keyword OR with structured biomedical signals

**Date:** 2026-05-24
**Status:** Draft v1 (pending user review)
**Builds on:** [`2026-05-23-trial-eval-evidence-rigor.md`](./2026-05-23-trial-eval-evidence-rigor.md). Supersedes that spec's "Counter-evidence query" decision (the `(failed OR no benefit OR discontinued …)` PubMed OR-query) and the associated `state.counterEvidence: Citation[]` shape.

## Motivation

The current counter-evidence pipeline retrieves PubMed papers via free-text OR over sentiment vocabulary (`failed`, `no benefit`, `discontinued`, `futility`, `toxicity`, `negative`, `withdrawn`) ANDed with drug + condition. The match has no semantic anchor to the drug-on-mechanism relationship — it matches papers where any of those words appears anywhere in title/abstract. A paper titled "*No negative effects of drug X on outcome Y*" matches the same way as a phase-3 termination report. The mechanism-plausibility prompt then instructs the LLM to include at least one `supports: "no"` evidence row whenever any "counter-evidence" was retrieved, which forces a label onto bogus matches — and the PMID-echo filter doesn't catch it because the PMID *is* in `counterEvidence`.

The fix is not to soften the prompt instruction (review item #5's surface remedy). The fix is to stop calling free-text keyword hits "counter-evidence" at all. Counter-evidence should come from structured biomedical signals: curated KG annotations, learned KG predictions, and structured trial-registry outcomes.

## Scope (in)

1. **Delete** the PubMed counter-evidence query (`buildCounterQuery`, `COUNTER_TERMS`) from `literature-support`. The node now does only the supporting PubMed pass.
2. **Delete** `state.counterEvidence: Citation[]`.
3. **Add** `state.structuredCounterEvidence` with three sources:
   - `primeKgContraindications`: PrimeKG `(:drug)-[:contraindication]-(:disease)` edges between each trial intervention and the patient's condition.
   - `txGnnPredContraindication`: the `predContraindication` field on the `RepurposingCandidate` that matches the current trial (looked up from `state.repurposingCandidates` via `state.candidate.repurposingDrugIds`, mirroring `mechanism-plausibility.ts:74-76`'s `pickSource` pattern). `null` when the trial wasn't surfaced via the repurposing channel or no matching candidate is in state. Surfaced explicitly as a counter-evidence signal rather than buried in the weighting guidance.
   - `terminatedPriorTrials`: prior trials of the drug + condition with `overallStatus ∈ {TERMINATED, WITHDRAWN, SUSPENDED}`, including the raw `whyStopped` text **unfiltered**. The judge LLM decides whether each stop reason is real biomedical counter-evidence vs administrative noise.
4. **Add** a new node `gather-counter-evidence` running in parallel with `literature-support`. Both fan in to `mechanism-plausibility`.
5. **Update** `prompts/mechanism-plausibility.ts`: replace the "Counter-evidence from PubMed" block with a "Counter-evidence (structured signals)" block containing labeled subsections. Delete the "include at least one `supports: 'no'`" instruction.
6. **Update** `synthesize-match`'s "counter-evidence not addressed" concern to gate on `structuredCounterEvidence` having any non-empty source rather than `counterEvidence.length > 0`.
7. **Extend** `tools/clinicaltrials.ts` with a sibling entry point `searchTerminatedPriorTrials({ intervention, condition })` that returns the new `PriorTerminatedTrial` shape (mechanism-judging fields only; not `TrialCandidate`).

## Scope (out)

- **Path A (TxGNN-channel templated rationale).** Unchanged.
- **Mechanism-plausibility Path B unification or rewrite.** Out — only the counter-evidence inputs change.
- **RxNorm / DrugBank synonym crosswalk** (already flagged as a separate hardening target in `kg.ts:374-376`). We trust CT.gov's own intervention-name index for synonym coverage in v1. See Risks §1.
- **Drug-drug interaction edges in PrimeKG.** Orthogonal — review item #8.
- **`safetyLookupOk` flag** (review item #7). Should be done as a bundle with this work but is not strictly part of the counter-evidence redesign; defer to the implementation plan to decide whether to fold in.
- **Path-B-only concerns gating fix** (review item #2). Orthogonal.

## Goal

Move counter-evidence in `mechanism-plausibility` from **"free-text PubMed papers matching negative-sentiment vocabulary"** to **"three structured biomedical signals about this drug-condition pair, judged by the LLM on their merits."** The judge sees:

1. PrimeKG curated contraindications (high-trust assertions, no PMID).
2. TxGNN learned predContraindication (when repurposing channel surfaced the trial).
3. CT.gov terminated/withdrawn/suspended prior trials of the same drug+condition, with raw `whyStopped` text.

…and decides whether each constitutes real counter-evidence against the mechanism. No keyword vocabulary to maintain. No bogus `supports: "no"` rows forced by retrieved-but-irrelevant abstracts.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Counter-evidence sources | PrimeKG contraindication edges + TxGNN predContraindication + CT.gov terminated/withdrawn/suspended trials | All three are structured (KG triples, learned scores, registry status enums). None requires sentiment-keyword matching against free text. User explicitly excluded PubMed-based options. |
| PubMed counter-evidence | **Deleted entirely.** | The whole point of this redesign. Retaining a PubMed pass even as a tertiary signal re-introduces the failure mode. |
| `whyStopped` filtering | **None.** Pass the raw `whyStopped` string to the LLM unfiltered. | CT.gov v2 has no controlled-vocabulary field for stop reasons (verified against `/api/v2/studies/metadata`: `whyStopped` is `type: markup`, no enum equivalent). Building our own keyword filter list reproduces the exact problem we're fixing. The LLM reads one short sentence per trial and judges. |
| CT.gov drug match | `query.intr=<trial intervention name>` only; trust CT.gov's own indexing for synonyms | PrimeKG has no synonyms list (verified: `keys(:Node{type:'drug'}) = [id, type, name, source]`; all 7957 drug nodes have `source = "DrugBank"`; single `name` per node). Building synonym expansion ourselves needs an RxNorm/DrugBank crosswalk that is out of scope. CT.gov's intervention index covers many synonym sets internally. See Risks §1 for the spot-check we'll do during implementation. |
| CT.gov pageSize | 20 per query (default elsewhere is 50) | This is a "show the LLM representative examples", not exhaustive enumeration. 20 most-recent terminated trials per intervention is plenty. |
| Where to compute | New parallel node `gather-counter-evidence`, sibling to `literature-support` | `literature-support` was a misnomer once it had two semantically different jobs (supporting + counter). Splitting yields two single-purpose nodes, each independently testable and soft-failable. Parallel fan-in to `mechanism-plausibility` matches the existing pattern. |
| State field name | `structuredCounterEvidence` (not `counterEvidence`) | Different shape from the old field; rename surfaces the migration in code review. The old name overloads to mean "the things we'll label `supports: 'no'`" which is no longer what we do. |
| `PriorTerminatedTrial` shape | New type in `packages/shared`; **not** `TrialCandidate` | `TrialCandidate` carries provenance (`discoveredVia`, `repurposingDrugIds`), eligibility fields, and locations — irrelevant for mechanism judging. New type contains only the fields the prompt formats. |
| Output schema | Keep `evidence[].supports: "yes" \| "weak" \| "no"`. **Delete** the "include at least one `supports: 'no'`" instruction. | The `supports: "no"` label still has meaning when applied to *supporting* literature (a Tier-1 RCT that directly reports failure). The forcing instruction was the bug; the label itself is fine. |
| `counterEvidenceAddressed` | Keep the field, rephrase the instruction | "If any structured counter-evidence was present (PrimeKG contraindication, high TxGNN predContraindication, or terminated prior trials with real biomedical stop reasons), one sentence on whether/how it affects the score. Omit if none was present or none was on-point." |
| TxGNN threshold | None — pass raw score, let the LLM judge "high" | The prompt language ("0.81 (high; treat as a learned negative signal)") gives the model enough context. Picking a numeric cutoff (e.g. >0.5) here would be premature and brittle. |
| Decide-if-more-evidence loop | Gates only `literature-support`. `gather-counter-evidence` runs once. | Broadening makes sense for PubMed (relax query, more hits). Structured signals are deterministic — re-querying yields the same result. |
| Soft-fail policy | Match `eligibility-check`'s pattern: catch errors per source, log warning, set that source to `[]` / `null` in `structuredCounterEvidence` | An outage in one source shouldn't kill the candidate's evaluation. See Risks §3 for the silent-bypass concern this creates. |
| `literature-support` rename | Optional; flag and leave to implementer taste | Now single-purpose. `supporting-literature` or `literature-support` both fine. |

## Architecture / topology

Current:
```
… → literature-support ⇄ decide-if-more-evidence → mechanism-plausibility → synthesize-match
```
(`literature-support` does supporting PubMed + counter PubMed in parallel.)

New:
```
                  ┌── literature-support ⇄ decide-if-more-evidence ──┐
                  │                                                  │
… → eligibility-check                                                ├─→ mechanism-plausibility → synthesize-match
                  │                                                  │
                  └── gather-counter-evidence (one-shot, no loop) ───┘
```

`gather-counter-evidence` and `literature-support` have no dependency on each other — both read the same upstream state (`candidate`, `mechanisms`, `patientProfile`, `repurposingContext`). They write disjoint state fields, so parallel fan-out + fan-in is safe.

## State changes (`subgraphs/trial-eval/state.ts`)

**Remove:**
```ts
counterEvidence: Citation[];
```

**Add:**
```ts
structuredCounterEvidence: {
  primeKgContraindications: KGContraindication[];    // reuse existing type from kg.ts
  txGnnPredContraindication: number | null;          // null when not repurposing channel
  terminatedPriorTrials: PriorTerminatedTrial[];
};
```

All three sub-fields use replace reducers; the new node writes the whole object once.

**New type (`packages/shared`):**
```ts
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
```

## Tool changes

**`tools/clinicaltrials.ts`:**

- Add to `FIELDS`: `protocolSection.statusModule.whyStopped`, `protocolSection.statusModule.completionDateStruct.date`, `protocolSection.statusModule.lastKnownStatus`.
- New exported function:
  ```ts
  export async function searchTerminatedPriorTrials(
    args: { intervention: string; condition: string; pageSize?: number },
  ): Promise<PriorTerminatedTrial[]>
  ```
  Builds: `query.intr=<intervention>`, `query.term=<condition>`, `filter.overallStatus=TERMINATED|WITHDRAWN|SUSPENDED`, `pageSize=20` (default). Reuses the existing `fetchWithRetry` and rate-limit pattern. Returns the stripped shape (not `TrialCandidate`).
- Existing `searchClinicalTrials(q: CtgQuery)` and its "term and intervention are mutually exclusive" contract are **unchanged**. New behavior lives in the sibling function.

**`tools/kg.ts`:**

- `findContraindicationsForDrugs(drugIds: string[], diseaseIds: string[]): Promise<SafetyConcern[]>` already exists at `kg.ts:347` (used by `eligibility-check`). Reuse as-is — the existing signature already takes arrays for both and returns the shape we need. `gather-counter-evidence` builds the `drugIds` list by mapping each trial intervention through `resolveDrugByName` (filter out nulls) and `diseaseIds` from `state.patientProfile.conditions[*].id` (or `state.mechanisms[*].conditionId`, whichever is canonical at this point in the graph; confirm during implementation).

## New node: `subgraphs/trial-eval/nodes/gather-counter-evidence.ts`

```ts
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
```

Note: `pickSource` currently lives in `mechanism-plausibility.ts`. Extract it to a shared location (e.g. `subgraphs/trial-eval/util/repurposing.ts`) so both nodes import it — avoids duplicating the lookup logic and keeps the two sites in lockstep if the matching rule ever changes.

Both fetcher helpers wrap the underlying tool call in try/catch and return `[]` on error, logging a warning. Mirrors `literature-support`'s `safeSearch` shape.

The CT.gov fan-out is per trial intervention: iterate `state.candidate.interventions.slice(0, MAX_INTERVENTIONS_IN_QUERY)` (same `= 3` cap that `literature-support` uses), one query per intervention, dedupe results by `nctId` at merge time. If `interventions` is empty, skip the CT.gov fetch and set `terminatedPriorTrials: []`. Condition string for `query.term`: pick the first available from `state.mechanisms[0]?.conditionName ?? state.patientProfile.conditions[0]?.display` (same fallback chain `literature-support.ts:107-110` uses).

## Prompt changes (`prompts/mechanism-plausibility.ts`)

**Remove** lines 79-82 (the `counterBlock` construction) and lines 111-112 (the "Counter-evidence from PubMed" header and block insertion). Replace with a "Counter-evidence (structured signals)" block, only included when at least one source is non-empty:

```
Counter-evidence (structured signals):

  PrimeKG contraindications:
    - Osimertinib (DB09330) is annotated as contraindicated for interstitial lung disease (MONDO:0005275).

  TxGNN repurposing model:
    predContraindication = 0.81 (higher = TxGNN predicts this drug is contraindicated for the patient's disease; treat as a learned negative signal).

  Prior terminated / withdrawn / suspended trials of this drug + condition (CT.gov):
    - NCT01234567 [phase 3, TERMINATED 2021-08]: "Stopped early at interim analysis for lack of efficacy vs. standard of care."
    - NCT07654321 [phase 2, TERMINATED 2019-04]: "Sponsor business decision; not related to safety or efficacy."

  Judge each whyStopped on its merits. Real biomedical reasons (lack of efficacy, futility,
  safety, toxicity, adverse events, dose-limiting toxicity) are counter-evidence. Administrative
  reasons (low enrollment, funding withdrawn, sponsor business decision, regulatory changes,
  protocol amendments) are NOT counter-evidence — note them and discount.
```

If all three subsections are empty: `"No structured counter-evidence retrieved."` (explicit, not silent).

**Remove** the `"Include at least one counter-evidence quote (supports: 'no') if any counter-evidence is present."` line in the `Return:` block (current line 139-140). This was the proximate cause of bogus `supports: "no"` rows.

**Rephrase** the `counterEvidenceAddressed` instruction (current line 141-142):

> `counterEvidenceAddressed`: if any structured counter-evidence was present and on-point (a real biomedical contraindication, a high TxGNN predContraindication, or a prior trial terminated for a real biomedical reason), one sentence on whether/how it affects the score. Omit if no structured counter-evidence was retrieved, or if all retrieved signals turned out to be administrative noise.

**Reweight guidance** (around line 126-127): the "Strong counter-evidence significantly reduces the score" line now references structured counter-evidence. Add: "An on-point PrimeKG contraindication or a phase-3 trial terminated for lack of efficacy against the same condition is very strong counter-evidence."

## Synthesize-match changes (`subgraphs/trial-eval/nodes/synthesize-match.ts`)

Three touch points (`state.counterEvidence` is currently read from at lines 100 and 119, `state.counterEvidenceAddressed` at 119 and 137):

1. **PMID-echo filter (line 100).** Currently includes `...state.counterEvidence.map((c) => c.pmid)` in the allowed PMIDs. Drop that line — after this change, `mechanismEvidence` legitimately only draws from supporting literature. The filter becomes "PMIDs from `literatureSupport` only".

2. **"Counter-evidence not addressed" concern (line 119).** Replace `state.counterEvidence.length > 0` with a predicate over the new field:
   ```ts
   const hasStructuredCounterEvidence =
     state.structuredCounterEvidence.primeKgContraindications.length > 0 ||
     state.structuredCounterEvidence.txGnnPredContraindication !== null ||
     state.structuredCounterEvidence.terminatedPriorTrials.length > 0;

   if (hasStructuredCounterEvidence && !state.counterEvidenceAddressed) {
     concerns.push("Counter-evidence was retrieved but the mechanism judgment did not address it.");
   }
   ```
   `state.counterEvidenceAddressed` is already a top-level state field (`state.ts:63-66`), populated by `mechanism-plausibility`. That plumbing is unchanged.

3. **TrialMatch surface (line 137 area).** If `TrialMatch` currently carries a `counterEvidence: Citation[]` field for the clinician brief, replace it with `structuredCounterEvidence` (the same shape we put in state). If it doesn't carry that field, no change here. Verify the `TrialMatch` schema in `packages/shared` during implementation and update tests accordingly.

## Risks / open items

1. **CT.gov's drug-name indexing coverage is undocumented.** Spot-check during implementation against 2-3 known synonym sets:
   - osimertinib / AZD9291 / Tagrisso
   - trastuzumab / Herceptin / Kanjinti / Ogivri
   - pembrolizumab / MK-3475 / Keytruda

   For each, query `query.intr=<canonical>` and check that trials registered under the synonyms appear. If coverage is bad (say, <70% recall on the spot-checks), fall back to a "two-query union": run a second query with `query.intr=<PrimeKG canonical name>` if `resolveDrugByName` succeeded and the canonical differs from the trial's raw intervention string.

2. **CT.gov query budget.** Worst case: 3 interventions per candidate × ~50 candidates per patient = ~150 CT.gov queries per patient run. Respect the existing 14-in-flight concurrency cap at the search-trials node level. If the cap isn't enforced on the new function, add it. Confirm with the implementer.

3. **Silent KG-outage bypass.** A Neo4j outage in `gather-counter-evidence`'s PrimeKG fetch returns `[]`, indistinguishable from "no contraindications found". This is the same issue as review item #7 for `eligibility-check`. Add a `lookupOk: { primeKg: boolean; ctgov: boolean }` sub-object to `structuredCounterEvidence`, surface it to the LLM in the prompt ("PrimeKG contraindication lookup: BYPASSED (KG unavailable)"), and let the judge model factor it in. Bundle with the #7 fix if doing both.

4. **TxGNN signal duplication.** `predContraindication` is currently mentioned in the "how to weight signals" guidance of the prompt. After this change it's also in the counter-evidence block. Decision: keep the weighting guidance line, **remove** the explicit `predContraindication` value from the `discoveryChannelBlock` rendering (line 161) — the counter-evidence block is now the single source of truth for the score and the prompt can reference it once.

5. **`evidence[]` array may now be empty more often.** With counter-evidence removed from the PubMed stream, the LLM no longer has a forced `supports: "no"` row to emit. The schema still allows empty `evidence[]`. Synthesize-match's "no literature-cited evidence for mechanism" concern (review item #4) is unaffected — it fires on empty `mechanismEvidence` regardless of counter-evidence.

## Implementation order

This is the suggested order for the implementation plan; the writing-plans skill will refine.

1. New type `PriorTerminatedTrial` in `packages/shared` + schema export.
2. New `searchTerminatedPriorTrials` in `tools/clinicaltrials.ts` with tests (mock CT.gov response, verify field projection, verify URL construction).
3. New `gather-counter-evidence` node with tests (mock both fetchers, verify state shape, verify soft-fail behavior).
4. Wire `gather-counter-evidence` into the subgraph topology in parallel with `literature-support`.
5. Delete `buildCounterQuery`, `COUNTER_TERMS`, and counter-evidence handling from `literature-support` (its tests update too).
6. Update `state.ts`: drop `counterEvidence`, add `structuredCounterEvidence`.
7. Update `prompts/mechanism-plausibility.ts`: replace counter-block, remove forcing instruction, rephrase `counterEvidenceAddressed`, dedupe TxGNN rendering.
8. Update `synthesize-match.ts`: change the concerns predicate.
9. Spot-check CT.gov synonym coverage (Risks §1). If bad, add the two-query union.

## Migration / rollout

- No data migration: state shape changes are forward-only within a single run.
- No backwards-compat: this replaces the old shape, doesn't extend it. Old `counterEvidence` field is removed in the same PR.
- Tests: every changed file has a corresponding `.test.ts`. Update fixtures to match new shape.
