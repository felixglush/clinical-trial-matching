# Patient-to-Trial Matching with Mechanism Reasoning: Skeleton Design

**Date:** 2026-05-19
**Status:** Approved (skeleton scope only — node implementations are out of scope)
**Scope:** Repository structure and skeleton files for a patient-to-trial matching workflow augmented with biomedical knowledge graph reasoning. Built with LangGraph.js. Deployed as Next.js (Vercel) + LangGraph Agent (LangGraph Platform) + local Neo4j (Aura/self-host later).

## Goal

Stand up the project skeleton — directory structure, package boundaries, configuration files, local dev workflow — so the mechanism-augmented matching workflow can be implemented incrementally, node by node, in subsequent passes. No business logic is built in this phase; every node is a stub.

## Three data sources, three roles

| Source | Role |
|---|---|
| **Synthea (FHIR)** | Synthetic patient data — conditions, meds, prior treatments. Grounds the workflow in a specific patient. |
| **PrimeKG (subset)** | Biomedical knowledge graph — drugs, diseases, genes, pathways. Provides mechanism reasoning and surfaces drug repurposing candidates. |
| **ClinicalTrials.gov** | Recruiting trials by condition or intervention. The actionable destination. |
| **PubMed** | Literature support for mechanism hypotheses (evidence retrieval during per-trial evaluation). |

## Workflow being supported (for context only)

```
extract_patient_profile          (Synthea FHIR → structured profile)
        ↓
identify_relevant_mechanisms     (KG: patient conditions → genes / pathways)
        ↓
        ├───────────────────────────────────────────┐
        ↓                                           ↓
generate_search_strategy             find_repurposing_candidates
  (condition + mechanism terms)        (KG: pathways → drugs
        ↓                                approved for other conditions)
        │                                           ↓
        └───────────────────┬───────────────────────┘
                            ↓
                      search_trials
                      (two CT.gov queries: condition-based AND
                       drug-name-based; unioned, deduped)
                            ↓
                       pre_filter ──── (broaden if too few; attempts < 3)
                            ↓
                fan_out_evaluations  ── Send → [trial_eval_subgraph] × N
                            ↓
                            ↓  (matches accumulated via reducer)
                            ↓
                     rank_and_synthesize
                     (eligibility + mechanism + evidence → score)
                            ↓
                     human_approval (interrupt)
                            ↓
                           END

trial_eval_subgraph (per trial):
  eligibility_check ── (Synthea profile vs trial criteria)
        ↓
  mechanism_plausibility ── (KG paths: intervention → patient's disease)
        ↓
  literature_support ── (PubMed for trial drug + disease + mechanism)
        ↓
  decide_if_more_evidence ── (confidence < threshold && attempts < 2)
        │                                 ↓
        │                       (cycle: fetch broader PubMed query → re-eval)
        ↓
  synthesize_match ── (TrialMatch with all scores + repurposing_rationale)
```

Skeleton creates all files for this workflow but leaves node bodies as stubs.

## Architectural decisions

- **Language:** TypeScript end-to-end (LangGraph.js + Next.js).
- **Frontend deploy:** Vercel.
- **Graph runtime deploy:** LangGraph Platform (managed). Picked over self-hosted Agent Server (no infra to manage) and over library-mode-in-Next.js (fan-out workflows exceed Vercel function timeouts).
- **Knowledge graph backend:** **Neo4j**, local for prototype. Use [Neo4j Desktop](https://neo4j.com/download/) for easy click-to-start and the Browser UI for ad-hoc Cypher exploration (or `docker run neo4j` if preferred). Production hosting is a deferred decision (Aura paid, self-hosted on Railway/Fly.io, etc.).
- **Knowledge graph data:** **PrimeKG subset** — drugs, diseases, genes/proteins, biological processes. Drop side effects, exposures, anatomy for prototype. Targets ~10K nodes / ~500K edges. Loaded offline once via Cypher import.
- **PubMed:** E-utilities REST API — no auth, no SDK, plain `fetch`.
- **Repo layout:** pnpm workspaces monorepo. Verified that both Vercel and LangGraph Platform natively support workspace deps via `workspace:*`.
- **LLM:** Any model via [OpenRouter](https://openrouter.ai/) using `@langchain/openai`'s `ChatOpenAI` pointed at OpenRouter's OpenAI-compatible API. Default model: `anthropic/claude-sonnet-4.6`. Lets us swap models (GPT, Gemini, Llama, etc.) by changing one string. OpenRouter passes through Anthropic prompt caching for supported models — verify cache hits in OpenRouter's dashboard before assuming cost parity with direct Anthropic.
- **Local dev:** `langgraph dev` (agent on :2024 with Studio) + `next dev` (web on :3000) + Neo4j Desktop on bolt://localhost:7687.
- **Synthea integration:** offline only — generate FHIR bundles via a script, commit a small sample set to `data/patients/`. Not a runtime dependency.
- **PrimeKG integration:** offline only — download CSVs, filter to subset, run Cypher LOAD into local Neo4j via a script. Not redownloaded at runtime.

## Repository structure

```
/
├── package.json                        # workspace root, dev scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json                  # shared compiler options
├── .nvmrc                              # node 20
├── .gitignore
├── .editorconfig
├── .env.example
├── README.md
│
├── apps/
│   ├── agent/                          # LangGraph workflow → LangGraph Platform
│   └── web/                            # Next.js → Vercel
│
├── packages/
│   └── shared/                         # @clinical-trial-matching/shared (zod schemas + types)
│
├── data/
│   ├── patients/                       # Synthea FHIR bundle samples (committed)
│   └── kg/                             # PrimeKG subset CSVs (gitignored; loaded into Neo4j)
│
├── scripts/
│   ├── generate-patients.sh            # wraps Synthea JAR
│   ├── build-primekg-subset.ts         # downloads + filters PrimeKG CSVs
│   ├── load-primekg-to-neo4j.cypher    # Cypher LOAD CSV script
│   └── README.md
│
└── docs/
    └── superpowers/specs/
```

## `apps/agent/` — LangGraph workflow

Owns the graph, state, nodes, subgraph, tools, and prompts. Deploys to LangGraph Platform.

```
apps/agent/
├── langgraph.json                      # Platform deploy config; entrypoint ./src/graph.ts:graph
├── package.json                        # @langchain/langgraph, @langchain/openai,
│                                       #   neo4j-driver, zod,
│                                       #   @clinical-trial-matching/shared: workspace:*
├── tsconfig.json                       # extends tsconfig.base.json
├── .env.example                        # OPENROUTER_API_KEY, LANGSMITH_*, NEO4J_*, PUBMED_API_KEY
└── src/
    ├── graph.ts                        # main StateGraph; exports `graph`
    ├── state.ts                        # Annotation + reducers (matches concat, attempts counter)
    ├── llm.ts                          # single configured Anthropic client
    │
    ├── nodes/                          # one file per node
    │   ├── extract-patient-profile.ts
    │   ├── identify-relevant-mechanisms.ts
    │   ├── find-repurposing-candidates.ts
    │   ├── generate-search-strategy.ts
    │   ├── search-trials.ts
    │   ├── pre-filter.ts
    │   ├── route-after-pre-filter.ts   # routing fn: broaden | Send[] for fan-out
    │   ├── rank-and-synthesize.ts
    │   └── human-approval.ts           # calls interrupt()
    │
    ├── subgraphs/
    │   └── trial-eval/
    │       ├── graph.ts                # per-trial eval subgraph with evidence-fetch cycle
    │       ├── state.ts                # subgraph-local state
    │       └── nodes/
    │           ├── eligibility-check.ts
    │           ├── mechanism-plausibility.ts
    │           ├── literature-support.ts
    │           ├── decide-if-more-evidence.ts  # routing fn for the cycle
    │           └── synthesize-match.ts
    │
    ├── tools/
    │   ├── clinicaltrials.ts           # clinicaltrials.gov v2 REST client
    │   ├── kg.ts                       # Neo4j driver + typed Cypher query helpers
    │   ├── pubmed.ts                   # PubMed E-utilities REST client
    │   └── patient-loader.ts           # reads data/patients/ FHIR bundles
    │
    └── prompts/                        # extracted prompt templates
        ├── extract-profile.ts
        ├── mechanism.ts
        ├── repurposing.ts
        ├── search-strategy.ts
        ├── pre-filter.ts
        ├── eligibility.ts
        ├── mechanism-plausibility.ts
        ├── literature-synthesis.ts
        └── rank.ts
```

**Conventions:**
- One node per file; node exports `async function (state) { ... }`.
- `state.ts` is the schema source of truth; defines reducers for `matches` (concat from fan-out) and `attempts` (broaden-retry counter).
- Subgraph is a real `StateGraph` invoked via `Send`. Subgraph state is isolated; only returned `TrialMatch` flows back through the parent reducer.
- Tools are plain async functions, not LangChain `tool()` wrappers. Wrap as tools later only if/when we add agentic tool-use.
- `llm.ts` is the single LLM config point — model, temperature, retry.
- Prompt text/templates live in `prompts/`, separated from graph logic.

**Skeleton scope:** all files exist; node bodies are stubs that return placeholder state; conditional edges are wired with stub predicates; prompt files export empty templates with `// TODO` markers.

## `apps/web/` — Next.js frontend

Patient-centric UI. Lets you select a patient, kick off a matching run, view live agent reasoning as it streams, review past runs, and (future) chat about the trials selected for that patient.

```
apps/web/
├── package.json                        # next, react, @langchain/langgraph-sdk, tailwind, shadcn,
│                                       #   @clinical-trial-matching/shared: workspace:*
├── next.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── components.json
├── .env.example
└── src/
    ├── app/
    │   ├── layout.tsx                          # sidebar (patient list) + main content
    │   ├── page.tsx                            # landing: "select a patient" empty state
    │   ├── patients/
    │   │   └── [patientId]/
    │   │       ├── layout.tsx                  # patient header
    │   │       ├── page.tsx                    # match history + "Run new match"; shows
    │   │       │                                 # active run inline if one is in-flight
    │   │       ├── runs/[threadId]/
    │   │       │   └── page.tsx                # full run view, live or historical
    │   │       └── chat/
    │   │           └── page.tsx                # "Coming soon" placeholder
    │   └── api/
    │       ├── patients/route.ts                       # GET list
    │       ├── patients/[patientId]/route.ts           # GET profile + FHIR
    │       ├── patients/[patientId]/runs/route.ts      # GET runs for patient; POST start new run
    │       └── runs/[threadId]/
    │           ├── stream/route.ts                     # SSE proxy of client.runs.stream()
    │           ├── state/route.ts                      # GET current state (historical view)
    │           ├── history/route.ts                    # GET checkpoint history (reasoning trace)
    │           └── resume/route.ts                     # POST resume after approval interrupt
    │
    ├── components/
    │   ├── ui/                                 # shadcn primitives
    │   ├── patient-sidebar.tsx
    │   ├── patient-header.tsx
    │   ├── match-history-list.tsx
    │   ├── run-view/
    │   │   ├── index.tsx
    │   │   ├── graph-timeline.tsx              # nodes as steps: running/done/pending
    │   │   ├── reasoning-trace.tsx             # per-node LLM output, streamed
    │   │   ├── mechanisms-panel.tsx            # KG-derived mechanisms + repurposing candidates
    │   │   ├── candidates-panel.tsx            # trials as they're added/filtered/ranked,
    │   │   │                                     # with mechanism + repurposing badges per match
    │   │   └── approval-panel.tsx              # interrupt UI: approve / reject / edit
    │   └── chat/
    │       └── placeholder.tsx
    │
    └── lib/
        ├── langgraph.ts                        # configured Client from @langchain/langgraph-sdk
        ├── patients-loader.ts                  # server-only: reads data/patients/ FHIR bundles
        └── types.ts                            # re-exports from shared
```

**Design choices:**
- **Patient-centric routing.** `/patients/[id]` and `/patients/[id]/runs/[threadId]`. Sidebar always shows patients.
- **LangGraph threads ARE the runs DB.** New runs create a thread tagged with `{ patientId }` metadata; `client.threads.search({ metadata: { patientId } })` returns the patient's match history. No duplicate DB.
- **Reasoning trace from checkpoint history.** `client.threads.getHistory(threadId)` returns the full per-node state sequence; the trace UI renders it. No custom event logging.
- **Three-stream subscription for live runs.** `stream_mode: ['values', 'updates', 'messages']`:
  - `updates` drives the graph timeline (which node just fired).
  - `values` drives the candidates panel (current `matches`/`candidates`).
  - `messages` drives the reasoning trace (token-level LLM output).
- **Page reconnects to in-flight runs.** `/patients/X/runs/Y` checks thread status: running → open stream; interrupted → show approval panel; done → render historical. Survives reload and tab switches.
- **API routes are thin proxies.** Hold the LangGraph API key server-side; forward to the SDK. Graph never runs inside Next.js.
- **Chat is stubbed.** Route exists, placeholder content. Future phase likely wires a separate chat-mode agent that loads the patient's most recent matches as context.

**Skeleton scope:** pages render placeholders; API routes return mock data or proxy stub responses; UI components have realistic structure but stubbed content.

## `packages/shared/` — domain contract

Source of truth for types that flow between the agent and the web app.

```
packages/shared/
├── package.json                        # name: @clinical-trial-matching/shared, dep: zod
├── tsconfig.json
└── src/
    ├── index.ts                        # barrel export
    ├── patient.ts                      # PatientProfile schema
    ├── mechanism.ts                    # Mechanism (gene/pathway/process + KG path evidence)
    ├── repurposing.ts                  # RepurposingCandidate (drug + original indication
    │                                   #   + mechanism rationale)
    ├── search.ts                       # SearchStrategy schema
    ├── trial.ts                        # TrialCandidate (raw CT.gov) + TrialMatch (extended:
    │                                   #   mechanismScore, literatureSupport,
    │                                   #   repurposingRationale)
    ├── eligibility.ts                  # EligibilityAssessment (per-criterion)
    ├── pubmed.ts                       # Citation (pmid, title, abstract excerpt, year)
    ├── run.ts                          # ApprovalRequest, ApprovalResponse, RunStatus
    └── state.ts                        # public GraphState shape; now includes
                                        #   mechanisms, repurposingCandidates
```

**Conventions:**
- Every file exports `XSchema` (zod) and `X` (`z.infer<typeof XSchema>`). Agent uses schemas to validate LLM outputs and external API responses; web uses just types.
- Shared owns **domain** types, not workflow types. Agent's LangGraph `Annotation` lives in `apps/agent/src/state.ts` and imports schemas from shared but wraps them with reducer machinery. Shared has no LangGraph dependency.
- `state.ts` is the public state surface — the subset of agent state the web subscribes to. Internal-only agent fields don't appear here.

**Workspace dep verified:** both Vercel and LangGraph Platform resolve `"@clinical-trial-matching/shared": "workspace:*"` natively. LangGraph CLI auto-detects pnpm when run from repo root with `-c apps/agent/langgraph.json`. Vercel's project-root setting points to `apps/web` and resolves workspaces from repo root.

## Root configuration

`package.json` scripts:

```json
{
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "dev:agent": "pnpm --filter agent dev",
    "dev:web": "pnpm --filter web dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "patients:generate": "./scripts/generate-patients.sh",
    "kg:build-subset": "tsx scripts/build-primekg-subset.ts",
    "kg:load": "cypher-shell -u $NEO4J_USERNAME -p $NEO4J_PASSWORD -a $NEO4J_URI -f scripts/load-primekg-to-neo4j.cypher"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`: strict mode, ES2022 target, NodeNext module resolution, source maps. Apps extend this.

## Local dev workflow

1. `pnpm install` from repo root.
2. **One-time:** install [Neo4j Desktop](https://neo4j.com/download/), create a local DBMS (any name; password is what you'll put in `.env`), and start it. Browser UI runs on `http://localhost:7474`; bolt protocol on `bolt://localhost:7687`.
3. **One-time:** seed the KG: `pnpm kg:build-subset && pnpm kg:load`. This downloads PrimeKG CSVs, filters to subset, and imports into Neo4j. Takes a few minutes.
4. `pnpm dev`:
   - `apps/agent`: `langgraph dev` starts the Agent Server on `localhost:2024` with embedded Postgres, hot reload, and Studio UI. Connects to Neo4j over bolt for KG queries.
   - `apps/web`: `next dev` on `localhost:3000`; `.env.local` points `LANGGRAPH_API_URL=http://localhost:2024`.
5. Visit `localhost:3000`: pick a patient, run a match, watch streaming output (including mechanism reasoning and repurposing candidates).
6. Studio at `localhost:2024` for low-level graph debugging. Neo4j Browser at `localhost:7474` for ad-hoc Cypher.

## Environment variables

```
# apps/agent/.env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-sonnet-4.6    # override default if you want a different model
LANGSMITH_API_KEY=                      # optional, enables tracing in dev
LANGSMITH_TRACING=true
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=                         # whatever you set in Neo4j Desktop
NEO4J_DATABASE=neo4j
PUBMED_API_KEY=                         # optional; raises rate limit from 3 to 10 req/sec

# apps/web/.env.local
LANGGRAPH_API_URL=http://localhost:2024
LANGGRAPH_API_KEY=                      # only needed against deployed Platform
```

## Synthea integration

`scripts/generate-patients.sh` clones Synthea on first run, generates N FHIR bundles into `data/patients/`, prints sample IDs. Documented in `scripts/README.md` (requires Java 11+). Skeleton commits 3–5 representative patient bundles so the app boots without anyone installing Java.

## PrimeKG integration

`scripts/build-primekg-subset.ts` downloads PrimeKG node and edge CSVs from Harvard Dataverse (~600MB total), filters to the subset (drug, disease, gene/protein, biological_process), and writes filtered CSVs to `data/kg/`. `scripts/load-primekg-to-neo4j.cypher` does `LOAD CSV WITH HEADERS` to import the subset into the local Neo4j instance — creating constraints (uniqueness on node `id`) and indexes (by `name` and `type`) before bulk loading edges. Both steps documented in `scripts/README.md`.

The agent's `tools/kg.ts` opens a single shared `Driver` at module init, exposes typed helpers:
- `findGeneTargetsForDisease(diseaseId): Promise<Gene[]>`
- `findSharedPathways(diseaseId, depth): Promise<Pathway[]>`
- `findDrugsTargetingPathways(pathwayIds): Promise<{ drug, indication, path }[]>`
- `pathBetween(fromId, toId, maxHops): Promise<KGPath[]>`

`data/kg/` is gitignored — large CSVs aren't committed. Anyone cloning the repo runs `pnpm kg:build-subset && pnpm kg:load` once.

## Deliberately out of scope (for skeleton)

- Node implementations — all stubs (including KG and PubMed tool stubs that throw).
- Prompt content — empty templates with TODOs.
- Auth (Clerk/NextAuth) — open access locally; revisit before public deploy.
- Real-time progress visualization beyond a basic list.
- Turborepo/Nx — pnpm `-r` is enough at this scale.
- Vitest/Jest setup — add when there's real logic to test.
- CI workflows — add when there's a test suite to gate on.
- Docker — LangGraph CLI handles its own containerization. Neo4j runs via Neo4j Desktop.
- **Production KG hosting** — deferred. Local Neo4j is sufficient for prototype; pick Aura paid / self-hosted later if needed.
- **Embedding / vector search** — could augment KG traversals later (semantic neighbor lookup for ambiguous condition names). Not in scope yet.
- **Full PrimeKG** — only the drug/disease/gene/process subset. Side effects, exposures, anatomy ignored.

## Verification

LangGraph Platform monorepo support and pnpm workspace handling verified against official docs (`langsmith/monorepo-support`). `langgraph dev` and `langgraph build` behavior verified (`langsmith/local-dev-testing`, `langsmith/setup-javascript`).
