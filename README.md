# Clinical Trial Matching

A patient-to-trial matching workflow that augments standard eligibility matching with **biomedical knowledge graph reasoning**. Given a patient's FHIR record, it identifies relevant disease mechanisms, surfaces drug-repurposing candidates from [PrimeKG](https://zitniklab.hms.harvard.edu/projects/PrimeKG/), queries [ClinicalTrials.gov](https://clinicaltrials.gov/) for recruiting trials, and ranks each match on a combined eligibility + mechanism + PubMed-evidence score.

Built with [LangGraph.js](https://langchain-ai.github.io/langgraphjs/). Deploys as a Next.js app (Vercel) + LangGraph agent (LangGraph Platform) backed by a Neo4j knowledge graph.

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
