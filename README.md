# Clinical Trial Matching

A patient-to-trial matching workflow that augments standard eligibility matching with **biomedical knowledge graph reasoning**. Given a patient's FHIR record, it identifies relevant disease mechanisms, surfaces drug-repurposing candidates from [PrimeKG](https://zitniklab.hms.harvard.edu/projects/PrimeKG/), queries [ClinicalTrials.gov](https://clinicaltrials.gov/) for recruiting trials, and ranks each match on a combined eligibility + mechanism + PubMed-evidence score.

Built with [LangGraph.js](https://langchain-ai.github.io/langgraphjs/). Deploys as a Next.js app (Vercel) + LangGraph agent backed by a Neo4j knowledge graph.

## Workflow

```
                       START
                         │
                         ▼
            extract-patient-profile
                         │
                         ▼
          identify-relevant-mechanisms
                  │              │
                  ▼              ▼
 find-repurposing-      generate-search-strategy ◀──┐
     candidates                                     │
                  │              │                  │
                  └──────┬───────┘                  │
                         ▼                          │
                   search-trials                    │
                         │                          │
                         ▼                          │
                    pre-filter ─── too few ─────────┘
                         │        (attempts < 3)
                         ▼
        Send × N  →  trial-eval-subgraph   (see below)
                         │
                         ▼
                 rank-and-synthesize
                         │
                         ▼
                   human-approval         (interrupt for review)
                         │
                         ▼
                        END
```

**trial-eval-subgraph** (one instance per candidate):

```
            eligibility-check
                    │
                    ▼
          mechanism-plausibility
                    │
                    ▼
           literature-support  ◀──┐
                    │             │
                    ▼             │
           < 3 citations? ────────┘
                    │  (attempts < 2)
                    ▼  (else)
             synthesize-match
```

### Nodes

**Main graph**

- `extract-patient-profile` — Load the patient's FHIR bundle and use an LLM to distill it into a structured `PatientProfile` (conditions, medications, prior treatments, demographics).
- `identify-relevant-mechanisms` — For each condition, query Neo4j/PrimeKG for associated genes and pathways; LLM picks the most clinically relevant.
- `find-repurposing-candidates` — KG query for drugs that target the identified pathways but are approved for *other* conditions; LLM narrates the repurposing rationale.
- `generate-search-strategy` — LLM composes condition + mechanism search terms for ClinicalTrials.gov. On retry, broadens the strategy.
- `search-trials` — Two CT.gov queries — one condition-based, one drug-based (from the repurposing candidates) — unioned and deduped by NCT ID.
- `pre-filter` — Cheap LLM-as-judge pass to drop obvious non-matches before the expensive per-trial evaluation.
- `route-after-pre-filter` *(conditional edge)* — If too few candidates survived and attempts remain, loop back to `generate-search-strategy` to broaden; otherwise fan out the top N candidates into the trial-eval subgraph via `Send`.
- `rank-and-synthesize` — After fan-out completes, LLM reranks matches end-to-end (eligibility + mechanism + literature) and assembles the approval request.
- `human-approval` — `interrupt()` for human review; supports approve / reject / edit.

**Per-trial evaluation subgraph**

- `eligibility-check` — LLM per-criterion analysis of inclusion/exclusion against the patient profile.
- `mechanism-plausibility` — KG path search (intervention → patient's condition); LLM scores how plausible the mechanism is.
- `literature-support` — PubMed query for trial drug + condition + mechanism; collect citations.
- `decide-if-more-evidence` *(conditional edge)* — If literature coverage is thin and attempts remain, loop back to `literature-support` with a broader query.
- `synthesize-match` — Combine eligibility + mechanism + literature into a final `TrialMatch` with a combined score.

## Data sources

Four external datasets feed the workflow. Two are offline (generated/loaded once, then read from disk or Neo4j); two are queried over REST at runtime.

### Synthea — patient input (offline)

[Synthea](https://github.com/synthetichealth/synthea) is MITRE's synthetic-patient simulator. It produces realistic FHIR R4 bundles for fictional patients with full medical history (conditions, medications, encounters, labs).

- **Role:** Grounds matching in a specific patient. `extract-patient-profile` reads the bundle.
- **Integration:** `pnpm patients:generate` runs the JAR with a fixed seed to produce a deterministic 200-patient pool in `data/synthea-output/`; the loaders ([apps/agent/src/tools/patient-loader.ts](apps/agent/src/tools/patient-loader.ts), [apps/web/src/lib/patients-loader.ts](apps/web/src/lib/patients-loader.ts)) resolve four pre-selected archetype patients by UUID from that pool. See [data/patients.md](data/patients.md) for the archetype roster and the rationale for each.
- **Requires:** Java 11+ and `data/synthea-with-dependencies.jar`. Free, no auth.

### PrimeKG — biomedical knowledge graph (offline)

[PrimeKG](https://zitniklab.hms.harvard.edu/projects/PrimeKG/) is the Zitnik Lab's precision-medicine KG, integrating 20 biomedical sources (DrugBank, DisGeNET, Reactome, MONDO, …) into ~129K nodes and ~4M edges across diseases, drugs, genes/proteins, pathways, side effects, exposures, phenotypes, anatomy.

- **Role:** Mechanism reasoning (`identify-relevant-mechanisms`, `mechanism-plausibility`) and drug repurposing (`find-repurposing-candidates`). KG paths from a patient's conditions → genes/pathways → drugs surface repurposing candidates and let us score how plausible a trial intervention is for the patient's biology.
- **Integration:** `pnpm kg:build-subset` downloads PrimeKG CSVs from Harvard Dataverse (~600MB) and filters to a 4-type subset (drug + disease + gene/protein + biological_process — dropping side effects, exposures, anatomy, phenotypes, which aren't load-bearing for mechanism/repurposing). `pnpm kg:load` imports into a local Neo4j instance via `LOAD CSV`. `pnpm kg:build-crosswalk` then joins MONDO's SSSOM cross-references against the PrimeKG disease nodes to produce a committed SNOMED→PrimeKG lookup the agent uses at runtime. A single shared `neo4j-driver` is opened at agent startup; typed Cypher helpers live in `apps/agent/src/tools/kg.ts`. See [docs/primekg-querying.md](docs/primekg-querying.md) for query gotchas and [docs/kg-crosswalk.md](docs/kg-crosswalk.md) for crosswalk regeneration.
- **Resolution caveat:** PrimeKG captures *associations*, not biomarker-level predictions. It will tell you "EGFR is implicated in NSCLC" and "osimertinib targets EGFR" — it won't tell you "EGFR T790M mutation predicts osimertinib response." For mutation-precise matching we'd layer in OncoKB / CIViC / COSMIC later.
- **Requires:** Neo4j Desktop (or `docker run neo4j`). Free, no auth (Creative Commons license).

### ClinicalTrials.gov — recruiting trials (runtime)

NIH's [ClinicalTrials.gov](https://clinicaltrials.gov/) v2 REST API exposes trial metadata: NCT ID, conditions, interventions, eligibility criteria, recruitment status, locations, contacts.

- **Role:** The actionable destination. `search-trials` issues two queries per run — one by condition terms, one by drug names from the repurposing candidates — then unions and dedupes by NCT ID. Per-trial eligibility scoring runs in the fan-out subgraph.
- **Integration:** Runtime REST calls, no SDK, plain `fetch` from `apps/agent/src/tools/clinicaltrials.ts`.
- **Requires:** Nothing. Free, no auth, generous rate limits.

### PubMed — literature evidence (runtime)

NLM's [PubMed](https://pubmed.ncbi.nlm.nih.gov/) database (~35M biomedical citations), accessed via the E-utilities REST API (`esearch`, `efetch`, `esummary`).

- **Role:** Evidence retrieval inside the trial-eval subgraph. `literature-support` queries PubMed for citations supporting each candidate trial's drug + condition + mechanism. Thin hits trigger the `decide-if-more-evidence` loop, which broadens the query and retries.
- **Integration:** Runtime REST calls, no SDK, plain `fetch` from `apps/agent/src/tools/pubmed.ts`.
- **Requires:** Nothing. Optional `PUBMED_API_KEY` raises rate limit from 3 → 10 req/sec.

## Repo layout

```
apps/agent/             LangGraph workflow
apps/web/               Next.js app
packages/shared/        Shared zod schemas + types + patient-fixtures
data/synthea-output/    Synthea FHIR bundles (gitignored; generated locally)
data/kg/                PrimeKG subset CSVs (gitignored; built locally)
data/patients.md        Archetype patient roster
scripts/                Tooling (Synthea runner, PrimeKG subset builder, etc.)
docs/superpowers/       Design specs and implementation plans
```

## Local dev

Prerequisites: Node 24, pnpm 9, `OPENROUTER_API_KEY`, [Neo4j Desktop](https://neo4j.com/download/) (or Docker).

```bash
pnpm install
cp apps/agent/.env.example apps/agent/.env
cp apps/web/.env.example apps/web/.env.local
# fill in OPENROUTER_API_KEY and NEO4J_PASSWORD in apps/agent/.env
# start Neo4j Desktop and create a local DBMS
pnpm dev
```

- Agent (LangGraph dev server + Studio): http://localhost:2024
- Web (Next.js): http://localhost:3000
- Neo4j Browser: http://localhost:7474

One-time data load (when ready):
```bash
pnpm patients:generate         # Synthea FHIR bundles (requires Java 11+)
pnpm kg:build-subset           # PrimeKG → data/kg/
pnpm kg:load                   # PrimeKG → local Neo4j
pnpm kg:build-crosswalk        # SNOMED → PrimeKG disease crosswalk (MONDO SSSOM)
```

End-to-end test (4-patient mechanism rendering, requires the dev servers + Neo4j up):
```bash
pnpm --filter web test:e2e
```

## Project rules

See [CLAUDE.md](./CLAUDE.md).
