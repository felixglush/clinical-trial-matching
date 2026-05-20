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

## Repo layout

```
apps/agent/         LangGraph workflow (deploys to LangGraph Platform)
apps/web/           Next.js app (deploys to Vercel)
packages/shared/    Shared zod schemas + types
data/patients/      Synthea-generated FHIR bundle samples
scripts/            Tooling (Synthea runner, etc.)
docs/superpowers/   Design specs and implementation plans
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
```

## Project rules

See [CLAUDE.md](./CLAUDE.md).
