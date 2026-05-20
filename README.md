# Clinical Trial Matching

Patient-to-trial matching workflow built with LangGraph.js. Next.js frontend (Vercel) calls a LangGraph agent (LangGraph Platform).

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
