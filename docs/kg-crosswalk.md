# SNOMED → PrimeKG crosswalk

How the `apps/agent/src/data/snomed-to-primekg.json` artifact is produced,
when to regenerate it, and what it does and does not cover. The artifact
backs `apps/agent/src/tools/snomed-mondo.ts`, which the
[`identify-relevant-mechanisms`](../apps/agent/src/nodes/identify-relevant-mechanisms.ts)
node hits on every condition.

Build script: [`scripts/build-mondo-crosswalk.ts`](../scripts/build-mondo-crosswalk.ts).

## Why a crosswalk at all

PrimeKG diseases are MONDO-only (`node_source ∈ {MONDO, MONDO_grouped}`);
their `node_id` is a MONDO numeric id with no SNOMED column to join on.
Patient conditions arrive from FHIR with SNOMED CT codes. Without a
crosswalk we'd be left with fuzzy name matching — fragile on granular
MONDO subtypes (e.g. PrimeKG has "breast carcinoma", "female breast
carcinoma", "breast adenocarcinoma" — not "breast cancer") and helpless
on synonyms.

MONDO publishes authoritative cross-references in SSSOM (Simple Standard
for Sharing Ontological Mappings) format. We download it offline,
restrict to SNOMED objects (`SCTID:`) with strong predicates
(`skos:exactMatch`, `skos:closeMatch`), join against our PrimeKG subset's
disease nodes (handling `MONDO_grouped` fan-out), and emit a plain JSON
dict. The runtime never touches SSSOM directly — boot stays I/O-free,
and the agent works on LangGraph Platform without a 13 MB download per
cold start.

## How to (re)generate

```bash
pnpm kg:build-subset      # if data/kg/nodes.csv is missing
pnpm kg:build-crosswalk
```

The build script:

1. Downloads `mondo.sssom.tsv` to `data/kg/raw/` (skips if present).
2. Streams `data/kg/nodes.csv`, building `mondoNumericId → {primekgNodeId, primekgName}`.
   For `MONDO_grouped` rows (`node_id` like `"11123_12919_7454_..."`),
   each member numeric id maps to the same PrimeKG node.
3. Streams SSSOM rows. Keeps only `object_id` starting with `SCTID:` and
   `predicate_id` in `{skos:exactMatch, skos:closeMatch}`. Drops
   `broadMatch` / `narrowMatch` (too lossy for trial eligibility).
4. Collision policy: same SNOMED code mapped to multiple MONDO entries →
   prefer `exactMatch` over `closeMatch`; ties keep first by file order.
5. Sorts keys for stable diffs. Writes
   `apps/agent/src/data/snomed-to-primekg.json`.

The script logs counts on success (rows scanned / SCTID kept / matched
in PrimeKG / collisions / final entries). The current build emits **8,993
entries**.

Commit the regenerated JSON.

## When to regenerate

- **MONDO releases a new version** (≈ monthly). New mappings get added;
  some MONDO ids get retired or remapped. The crosswalk is currently
  pulled from MONDO `master`, **not pinned to a release tag** — see
  "Known limitations" below.
- **The PrimeKG subset changes.** If `pnpm kg:build-subset` adds disease
  nodes (e.g. by widening `KEPT_NODE_TYPES` in
  [`scripts/build-primekg-subset.ts`](../scripts/build-primekg-subset.ts)),
  some previously-unmapped SNOMED codes will start resolving.
- **You see unexpected `unresolved` warnings in the agent logs** for
  conditions that clearly should be in MONDO. The crosswalk might be
  stale.

Re-running the script with `data/kg/raw/mondo.sssom.tsv` already present
will reuse the local copy. Delete the file to force a fresh download.

## What's covered

Only **SNOMED CT → MONDO** mappings present in MONDO's SSSOM file. Spot
checks (see `apps/agent/src/tools/snomed-mondo.test.ts`):

| SNOMED code  | Resolves to                              |
| ------------ | ---------------------------------------- |
| `69896004`   | rheumatoid arthritis (MONDO:0008383)     |
| `44054006`   | type 2 diabetes mellitus (MONDO:0005148) |
| `254637007`  | non-small cell lung carcinoma (MONDO:0005233) |
| `254837009`  | breast cancer (MONDO:0007254)            |
| `709044004`  | chronic kidney disease (MONDO:0005300)   |

All four archetype patients have their primary diagnoses resolved.

## What's *not* covered

- **No ICD-9 / ICD-10 / ICD-10-CM bridging.** A FHIR Condition coded only
  in ICD-10 will not resolve. MONDO SSSOM contains ICD mappings; we
  deliberately skip them for now because Synthea emits SNOMED. Add an
  ICD branch to the build script when we ingest real EHR feeds.
- **No RxNorm / LOINC.** Crosswalk is disease-scoped. Drug-to-PrimeKG and
  lab-to-PrimeKG are separate problems (and `find-repurposing-candidates`
  will need a drug crosswalk eventually).
- **No `broadMatch` / `narrowMatch`.** These widen / narrow the concept
  (e.g. "diabetes" broad-matching to "diabetes mellitus type 2"), which
  would inflate false positives in trial eligibility.
- **Synthea SNOMED codes that aren't *diseases*.** Synthea emits codes
  for findings, situations, social determinants, etc. Expect 3–11
  unresolvable codes per archetype patient — these are usually findings
  like "Past pregnancy history of miscarriage", "Prediabetes",
  "Body mass index 30+ - obesity". They legitimately have no MONDO
  disease entry; the node skips them and logs.
- **Conditions PrimeKG simply doesn't carry.** Our subset drops side
  effects, exposures, phenotypes, and anatomy (see
  `KEPT_NODE_TYPES` in `build-primekg-subset.ts`). A SNOMED code for a
  phenotype won't resolve even though MONDO knows about it.

## Known limitations and follow-ups

- **Source is unpinned.** The script pulls from MONDO's `master` branch,
  not a release tag. Reproducibility suffers — re-running months later
  picks up upstream churn. Pin to a release tag (e.g.
  `releases/v2026-05-05/...`) once we cut a v1.
- **No predicate-kind metadata in the output.** We collapse `exactMatch`
  and `closeMatch` into the same JSON shape. If `closeMatch` resolutions
  ever cause LLM confusion, expose the predicate so downstream consumers
  (or the prompt) can be slightly more skeptical.
- **One-MONDO-per-SNOMED.** SSSOM can record several MONDO targets for
  one SNOMED code (rare). We keep the first by file order after
  predicate preference. If multi-mapping becomes important, change the
  shape to `Record<string, CrosswalkEntry[]>`.

## Troubleshooting

| Symptom                                | Likely cause / fix |
| -------------------------------------- | ------------------ |
| `missing data/kg/nodes.csv. Run 'pnpm kg:build-subset' first` | PrimeKG subset not built yet. Run it. |
| `crosswalk produced 0 entries — input shapes likely changed`  | Either SSSOM column names drifted, or the PrimeKG `node_type`/`node_source` casing changed. Re-read `nodes.csv` header and the SSSOM header. |
| `404` downloading SSSOM                | MONDO moved the file. Search `monarch-initiative/mondo` for `mondo.sssom.tsv`; update `SSSOM_URL` in the script. |
| Single archetype condition not resolving in agent logs | Look it up in the JSON. If absent, check whether MONDO has a SNOMED mapping for it at all (search the raw `mondo.sssom.tsv` for the SCTID). |
