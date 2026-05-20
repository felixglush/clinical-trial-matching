# Skeleton Implementation Plan (mechanism-augmented)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project skeleton (pnpm workspace monorepo, three packages, configs, stub files) for the mechanism-augmented patient-to-trial matching workflow (Synthea + PrimeKG + ClinicalTrials.gov + PubMed). Node implementations are stubs; the goal is `pnpm install && pnpm dev` boots both servers and `pnpm typecheck` passes.

**Architecture:** pnpm workspace monorepo. `apps/agent` (LangGraph.js workflow → LangGraph Platform), `apps/web` (Next.js → Vercel), `packages/shared` (zod schemas + types). Knowledge graph: local Neo4j Desktop, queried over `bolt://`. PubMed: plain REST, no auth.

**Tech Stack:** TypeScript 6.0.3, pnpm 9, Node 20, Next.js 16.2.6, React 19.2.6, LangGraph.js (`@langchain/langgraph` 1.3.2), LangGraph SDK (`@langchain/langgraph-sdk` 1.9.4), `@langchain/openai` 1.4.6 (pointed at OpenRouter, default model `anthropic/claude-haiku-4.5`), `neo4j-driver` 6.0.1, zod 4.4.3, Tailwind 4.3.0, shadcn/ui.

**LangGraph v1 note:** the `Annotation.Root(...)` API we use for state is still supported in v1 — no rewrite required. v1 introduces an alternative `StateSchema` + Zod-native API (`ReducedValue`, `MessagesValue`, etc.) that is more idiomatic alongside our Zod-based shared schemas. We're sticking with `Annotation` for the skeleton since it's already wired; migrate to `StateSchema` later if/when it pays off.

**Conventions:**
- All package.json dependency versions are exact (no `^`/`~`). See [CLAUDE.md](../../../CLAUDE.md).
- Every node and tool file is a stub that compiles and returns a placeholder partial state (or throws for tools); no real logic in this plan.
- No test framework setup — there is nothing meaningful to test until nodes have logic. Verification is `pnpm typecheck` and "the dev servers boot."
- KG and PubMed access is wired through `tools/kg.ts` and `tools/pubmed.ts` as stubs in this plan. ETL scripts are created but data import is a one-time manual step documented in `scripts/README.md`.

---

## File Structure

Files this plan creates, grouped by phase:

**Phase 1 — Root scaffolding:**
- `.npmrc`, `.nvmrc`, `.gitignore`, `.editorconfig`, `tsconfig.base.json`, `pnpm-workspace.yaml`, `package.json`, `README.md`

**Phase 2 — `packages/shared/`:**
- `package.json`, `tsconfig.json`
- `src/{patient,mechanism,repurposing,search,trial,eligibility,pubmed,run,state,index}.ts`

**Phase 3 — `apps/agent/`:**
- `package.json`, `tsconfig.json`, `langgraph.json`, `.env.example`
- `src/{llm,state,graph}.ts`
- `src/nodes/{extract-patient-profile,identify-relevant-mechanisms,find-repurposing-candidates,generate-search-strategy,search-trials,pre-filter,route-after-pre-filter,rank-and-synthesize,human-approval}.ts`
- `src/subgraphs/trial-eval/state.ts`, `src/subgraphs/trial-eval/graph.ts`
- `src/subgraphs/trial-eval/nodes/{eligibility-check,mechanism-plausibility,literature-support,decide-if-more-evidence,synthesize-match}.ts`
- `src/tools/{clinicaltrials,kg,pubmed,patient-loader}.ts`
- `src/prompts/{extract-profile,mechanism,repurposing,search-strategy,pre-filter,eligibility,mechanism-plausibility,literature-synthesis,rank}.ts`

**Phase 4 — `apps/web/`:**
- `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `components.json`, `.env.example` (Tailwind v4: no JS config file)
- `src/app/{layout,page,globals.css}.tsx|css`
- `src/app/patients/[patientId]/{layout,page}.tsx`
- `src/app/patients/[patientId]/runs/[threadId]/page.tsx`
- `src/app/patients/[patientId]/chat/page.tsx`
- `src/app/api/patients/route.ts`, `src/app/api/patients/[patientId]/route.ts`
- `src/app/api/patients/[patientId]/runs/route.ts`
- `src/app/api/runs/[threadId]/{stream,state,history,resume}/route.ts`
- `src/components/{patient-sidebar,patient-header,match-history-list}.tsx`
- `src/components/run-view/{index,graph-timeline,reasoning-trace,mechanisms-panel,candidates-panel,approval-panel}.tsx`
- `src/components/chat/placeholder.tsx`
- `src/components/ui/button.tsx` (one shadcn primitive to verify wiring)
- `src/lib/{langgraph,patients-loader,types}.ts`

**Phase 5 — Data + scripts:**
- `data/patients/{patient-1,patient-2,patient-3}.json`
- `scripts/generate-patients.sh`, `scripts/build-primekg-subset.ts`, `scripts/load-primekg-to-neo4j.cypher`, `scripts/README.md`

**Phase 6 — Verification & docs:**
- Verify everything boots (including a Neo4j connectivity smoke check), update root `README.md`.

---

## Phase 1: Root scaffolding

### Task 1: Create `.npmrc` and version pin files

**Files:**
- Create: `.npmrc`
- Create: `.nvmrc`

- [ ] **Step 1: Write `.npmrc`**

`.npmrc`:
```
save-exact=true
auto-install-peers=true
```

- [ ] **Step 2: Write `.nvmrc`**

`.nvmrc`:
```
20
```

- [ ] **Step 3: Commit**

```bash
git add .npmrc .nvmrc
git commit -m "chore: pin pnpm save-exact and node version"
```

### Task 2: Create `.gitignore` and `.editorconfig`

**Files:**
- Create: `.gitignore`
- Create: `.editorconfig`

- [ ] **Step 1: Write `.gitignore`**

`.gitignore`:
```
node_modules/
.next/
dist/
build/
.turbo/
.langgraph_api/
.synthea/
data/kg/
.agents/
skills-lock.json
.env
.env.local
.env.*.local
*.log
.DS_Store
.vscode/
.idea/
```

> `.agents/` and `skills-lock.json` are from the Vercel/agent-skills bootstrapper that may have scaffolded this project. Claude Code doesn't read them; keeping them gitignored so they don't follow the repo around.

- [ ] **Step 2: Write `.editorconfig`**

`.editorconfig`:
```
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore .editorconfig
git commit -m "chore: add gitignore and editorconfig"
```

### Task 3: Create `pnpm-workspace.yaml` and root `tsconfig.base.json`

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Write `pnpm-workspace.yaml`**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Write `tsconfig.base.json`**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json
git commit -m "chore: configure pnpm workspaces and base tsconfig"
```

### Task 4: Create root `package.json`

**Files:**
- Create: `package.json`

- [ ] **Step 1: Write `package.json`**

`package.json`:
```json
{
  "name": "clinical-trial-matching",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": "20"
  },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "dev:agent": "pnpm --filter agent dev",
    "dev:web": "pnpm --filter web dev",
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "lint": "pnpm -r run lint",
    "patients:generate": "./scripts/generate-patients.sh"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "prettier": "3.8.3"
  }
}
```

- [ ] **Step 2: Install (will succeed with no workspace packages yet)**

Run: `pnpm install`
Expected: completes without error; creates `pnpm-lock.yaml`.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: root package.json with workspace scripts"
```

### Task 5: Stub `README.md`

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

`README.md`:
````markdown
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

Prerequisites: Node 20, pnpm 9, `OPENROUTER_API_KEY`, [Neo4j Desktop](https://neo4j.com/download/) (or Docker).

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
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README quickstart"
```

---

## Phase 2: `packages/shared/`

### Task 6: `packages/shared/` package files

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`

- [ ] **Step 1: Write `packages/shared/package.json`**

`packages/shared/package.json`:
```json
{
  "name": "@clinical-trial-matching/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "typescript": "6.0.3"
  }
}
```

> Zod 4 note: most v3 schemas work unchanged in v4. Watch for: format validators moved off `z.string()` (use `z.url()`, `z.email()`, etc. standalone — already done in this plan), error message shape changed, some `.refine()` ergonomics differ.

- [ ] **Step 2: Write `packages/shared/tsconfig.json`**

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: installs zod 3.23.8 and typescript into `packages/shared/node_modules`.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/package.json packages/shared/tsconfig.json pnpm-lock.yaml
git commit -m "chore(shared): scaffold package"
```

### Task 7: `packages/shared/src/patient.ts`

**Files:**
- Create: `packages/shared/src/patient.ts`

- [ ] **Step 1: Write `patient.ts`**

`packages/shared/src/patient.ts`:
```ts
import { z } from "zod";

export const ConditionSchema = z.object({
  code: z.string(),
  display: z.string(),
  onsetDate: z.string().optional(),
  clinicalStatus: z.enum(["active", "resolved", "remission", "inactive"]).optional(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const MedicationSchema = z.object({
  code: z.string(),
  display: z.string(),
  status: z.enum(["active", "stopped", "completed"]).optional(),
});
export type Medication = z.infer<typeof MedicationSchema>;

export const LabSchema = z.object({
  code: z.string(),
  display: z.string(),
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  date: z.string().optional(),
});
export type Lab = z.infer<typeof LabSchema>;

export const PatientProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  ageYears: z.number().int().nonnegative(),
  sex: z.enum(["male", "female", "other", "unknown"]),
  conditions: z.array(ConditionSchema),
  medications: z.array(MedicationSchema),
  labs: z.array(LabSchema),
  priorTreatments: z.array(z.string()),
});
export type PatientProfile = z.infer<typeof PatientProfileSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/patient.ts
git commit -m "feat(shared): PatientProfile schema"
```

### Task 8: `packages/shared/src/search.ts`

**Files:**
- Create: `packages/shared/src/search.ts`

- [ ] **Step 1: Write `search.ts`**

`packages/shared/src/search.ts`:
```ts
import { z } from "zod";

export const SearchFiltersSchema = z.object({
  status: z.array(z.enum(["RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION", "NOT_YET_RECRUITING"])).optional(),
  phase: z.array(z.enum(["PHASE1", "PHASE2", "PHASE3", "PHASE4", "EARLY_PHASE1", "NA"])).optional(),
  country: z.string().optional(),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const SearchStrategySchema = z.object({
  queries: z.array(z.string()).min(1),
  filters: SearchFiltersSchema,
  attempt: z.number().int().nonnegative(),
  broadeningApplied: z.array(z.string()),
});
export type SearchStrategy = z.infer<typeof SearchStrategySchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/search.ts
git commit -m "feat(shared): SearchStrategy schema"
```

### Task 9: `packages/shared/src/trial.ts`

**Files:**
- Create: `packages/shared/src/trial.ts`

- [ ] **Step 1: Write `trial.ts`**

`packages/shared/src/trial.ts`:
```ts
import { z } from "zod";
import { EligibilityAssessmentSchema } from "./eligibility.js";
import { CitationSchema } from "./pubmed.js";
import { RepurposingRationaleSchema } from "./repurposing.js";

export const TrialLocationSchema = z.object({
  facility: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  status: z.string().optional(),
});
export type TrialLocation = z.infer<typeof TrialLocationSchema>;

export const TrialCandidateSchema = z.object({
  nctId: z.string(),
  title: z.string(),
  briefSummary: z.string().optional(),
  conditions: z.array(z.string()),
  interventions: z.array(z.string()),
  phase: z.string().optional(),
  status: z.string(),
  eligibilityCriteriaText: z.string().optional(),
  locations: z.array(TrialLocationSchema),
});
export type TrialCandidate = z.infer<typeof TrialCandidateSchema>;

export const TrialMatchSchema = TrialCandidateSchema.extend({
  score: z.number().min(0).max(100),
  summary: z.string(),
  eligibility: EligibilityAssessmentSchema,
  mechanismScore: z.number().min(0).max(100),
  mechanismRationale: z.string(),
  literatureSupport: z.array(CitationSchema),
  repurposingRationale: RepurposingRationaleSchema.nullable(),
  concerns: z.array(z.string()),
});
export type TrialMatch = z.infer<typeof TrialMatchSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/trial.ts
git commit -m "feat(shared): TrialCandidate and TrialMatch schemas with mechanism + literature fields"
```

### Task 10: `packages/shared/src/eligibility.ts`

**Files:**
- Create: `packages/shared/src/eligibility.ts`

- [ ] **Step 1: Write `eligibility.ts`**

`packages/shared/src/eligibility.ts`:
```ts
import { z } from "zod";

export const CriterionVerdictSchema = z.enum(["yes", "no", "unknown"]);
export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

export const CriterionAssessmentSchema = z.object({
  criterion: z.string(),
  met: CriterionVerdictSchema,
  evidence: z.string(),
});
export type CriterionAssessment = z.infer<typeof CriterionAssessmentSchema>;

export const OverallEligibilitySchema = z.enum([
  "eligible",
  "likely_eligible",
  "unclear",
  "likely_ineligible",
  "ineligible",
]);
export type OverallEligibility = z.infer<typeof OverallEligibilitySchema>;

export const EligibilityAssessmentSchema = z.object({
  inclusion: z.array(CriterionAssessmentSchema),
  exclusion: z.array(CriterionAssessmentSchema),
  overall: OverallEligibilitySchema,
});
export type EligibilityAssessment = z.infer<typeof EligibilityAssessmentSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/eligibility.ts
git commit -m "feat(shared): EligibilityAssessment schema"
```

### Task 10a: `packages/shared/src/mechanism.ts`

**Files:**
- Create: `packages/shared/src/mechanism.ts`

- [ ] **Step 1: Write `mechanism.ts`**

`packages/shared/src/mechanism.ts`:
```ts
import { z } from "zod";

export const KGNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["drug", "disease", "gene_protein", "biological_process"]),
  name: z.string(),
});
export type KGNode = z.infer<typeof KGNodeSchema>;

export const KGEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  relation: z.string(),
});
export type KGEdge = z.infer<typeof KGEdgeSchema>;

export const KGPathSchema = z.object({
  nodes: z.array(KGNodeSchema),
  edges: z.array(KGEdgeSchema),
});
export type KGPath = z.infer<typeof KGPathSchema>;

export const MechanismSchema = z.object({
  conditionId: z.string(),
  conditionName: z.string(),
  geneTargets: z.array(KGNodeSchema),
  pathways: z.array(KGNodeSchema),
  supportingPaths: z.array(KGPathSchema),
});
export type Mechanism = z.infer<typeof MechanismSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/mechanism.ts
git commit -m "feat(shared): Mechanism schema (KG nodes, edges, paths)"
```

### Task 10b: `packages/shared/src/repurposing.ts`

**Files:**
- Create: `packages/shared/src/repurposing.ts`

- [ ] **Step 1: Write `repurposing.ts`**

`packages/shared/src/repurposing.ts`:
```ts
import { z } from "zod";
import { KGNodeSchema, KGPathSchema } from "./mechanism.js";

export const RepurposingCandidateSchema = z.object({
  drug: KGNodeSchema,
  originalIndications: z.array(z.string()),
  rationale: z.string(),
  supportingPaths: z.array(KGPathSchema),
});
export type RepurposingCandidate = z.infer<typeof RepurposingCandidateSchema>;

export const RepurposingRationaleSchema = z.object({
  drugName: z.string(),
  originalIndications: z.array(z.string()),
  summary: z.string(),
});
export type RepurposingRationale = z.infer<typeof RepurposingRationaleSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/repurposing.ts
git commit -m "feat(shared): RepurposingCandidate and RepurposingRationale schemas"
```

### Task 10c: `packages/shared/src/pubmed.ts`

**Files:**
- Create: `packages/shared/src/pubmed.ts`

- [ ] **Step 1: Write `pubmed.ts`**

`packages/shared/src/pubmed.ts`:
```ts
import { z } from "zod";

export const CitationSchema = z.object({
  pmid: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  abstractExcerpt: z.string().optional(),
  url: z.url(),
});
export type Citation = z.infer<typeof CitationSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/pubmed.ts
git commit -m "feat(shared): Citation schema for PubMed references"
```

### Task 11: `packages/shared/src/run.ts`

**Files:**
- Create: `packages/shared/src/run.ts`

- [ ] **Step 1: Write `run.ts`**

`packages/shared/src/run.ts`:
```ts
import { z } from "zod";
import { TrialMatchSchema } from "./trial.js";

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ApprovalRequestSchema = z.object({
  patientId: z.string(),
  summary: z.string(),
  matches: z.array(TrialMatchSchema),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResponseSchema = z.object({
  action: z.enum(["approve", "reject", "edit"]),
  edits: z.array(TrialMatchSchema).optional(),
  notes: z.string().optional(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/run.ts
git commit -m "feat(shared): Run and Approval schemas"
```

### Task 12: `packages/shared/src/state.ts`

**Files:**
- Create: `packages/shared/src/state.ts`

- [ ] **Step 1: Write `state.ts`**

`packages/shared/src/state.ts`:
```ts
import { z } from "zod";
import { PatientProfileSchema } from "./patient.js";
import { MechanismSchema } from "./mechanism.js";
import { RepurposingCandidateSchema } from "./repurposing.js";
import { SearchStrategySchema } from "./search.js";
import { TrialCandidateSchema, TrialMatchSchema } from "./trial.js";
import { ApprovalRequestSchema } from "./run.js";

export const GraphStateSchema = z.object({
  patientId: z.string(),
  patientProfile: PatientProfileSchema.nullable(),
  mechanisms: z.array(MechanismSchema),
  repurposingCandidates: z.array(RepurposingCandidateSchema),
  searchStrategy: SearchStrategySchema.nullable(),
  candidates: z.array(TrialCandidateSchema),
  matches: z.array(TrialMatchSchema),
  attempts: z.number().int().nonnegative(),
  approvalRequest: ApprovalRequestSchema.nullable(),
  error: z.string().nullable(),
});
export type GraphState = z.infer<typeof GraphStateSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/state.ts
git commit -m "feat(shared): public GraphState schema"
```

### Task 13: `packages/shared/src/index.ts` barrel + typecheck

**Files:**
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Write `index.ts`**

`packages/shared/src/index.ts`:
```ts
export * from "./patient.js";
export * from "./mechanism.js";
export * from "./repurposing.js";
export * from "./pubmed.js";
export * from "./search.js";
export * from "./trial.js";
export * from "./eligibility.js";
export * from "./run.js";
export * from "./state.js";
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @clinical-trial-matching/shared typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): barrel export"
```

---

## Phase 3: `apps/agent/`

### Task 14: `apps/agent/` package + tsconfig

**Files:**
- Create: `apps/agent/package.json`
- Create: `apps/agent/tsconfig.json`
- Create: `apps/agent/.env.example`

- [ ] **Step 1: Write `apps/agent/package.json`**

`apps/agent/package.json`:
```json
{
  "name": "agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "langgraph dev",
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@clinical-trial-matching/shared": "workspace:*",
    "@langchain/core": "1.1.47",
    "@langchain/langgraph": "1.3.2",
    "@langchain/openai": "1.4.6",
    "neo4j-driver": "6.0.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@langchain/langgraph-cli": "1.2.2",
    "typescript": "6.0.3"
  }
}
```

- [ ] **Step 2: Write `apps/agent/tsconfig.json`**

`apps/agent/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "noEmit": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `apps/agent/.env.example`**

`apps/agent/.env.example`:
```
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-haiku-4.5
LANGSMITH_API_KEY=
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=clinical-trial-matching
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=
NEO4J_DATABASE=neo4j
PUBMED_API_KEY=
```

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: installs LangGraph deps; `apps/agent/node_modules/@clinical-trial-matching/shared` symlinks to `packages/shared`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/package.json apps/agent/tsconfig.json apps/agent/.env.example pnpm-lock.yaml
git commit -m "chore(agent): scaffold package"
```

### Task 15: `apps/agent/src/llm.ts`

**Files:**
- Create: `apps/agent/src/llm.ts`

- [ ] **Step 1: Write `llm.ts`**

`apps/agent/src/llm.ts`:
```ts
import { ChatOpenAI } from "@langchain/openai";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set");
}

export const llm = new ChatOpenAI({
  model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5",
  temperature: 0,
  maxRetries: 2,
  apiKey,
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      // Optional but recommended — used by OpenRouter for analytics + dashboard.
      "HTTP-Referer": "https://github.com/felixglush/clinical-trial-matching",
      "X-Title": "Clinical Trial Matching",
    },
  },
});
```

> Model name note: `anthropic/claude-haiku-4.5` is the OpenRouter slug at time of writing. Verify against the live model list (`https://openrouter.ai/models`) — OpenRouter renames slugs occasionally. To swap to a different provider's model, just change the env var (e.g. `OPENROUTER_MODEL=openai/gpt-4.1` or `google/gemini-2.5-pro`).

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/llm.ts
git commit -m "feat(agent): configure shared LLM client via OpenRouter"
```

### Task 16: `apps/agent/src/state.ts` — LangGraph Annotation

**Files:**
- Create: `apps/agent/src/state.ts`

- [ ] **Step 1: Write `state.ts`**

`apps/agent/src/state.ts`:
```ts
import { Annotation } from "@langchain/langgraph";
import type {
  PatientProfile,
  Mechanism,
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
  TrialMatch,
  ApprovalRequest,
} from "@clinical-trial-matching/shared";

export const AgentState = Annotation.Root({
  patientId: Annotation<string>,
  patientProfile: Annotation<PatientProfile | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  mechanisms: Annotation<Mechanism[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  repurposingCandidates: Annotation<RepurposingCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  searchStrategy: Annotation<SearchStrategy | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  candidates: Annotation<TrialCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  matches: Annotation<TrialMatch[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  attempts: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  approvalRequest: Annotation<ApprovalRequest | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/state.ts
git commit -m "feat(agent): state annotation with matches concat reducer"
```

### Task 17: Tool stubs

**Files:**
- Create: `apps/agent/src/tools/clinicaltrials.ts`
- Create: `apps/agent/src/tools/patient-loader.ts`
- Create: `apps/agent/src/tools/kg.ts`
- Create: `apps/agent/src/tools/pubmed.ts`

- [ ] **Step 1: Write `clinicaltrials.ts`**

`apps/agent/src/tools/clinicaltrials.ts`:
```ts
import type { SearchStrategy, TrialCandidate } from "@clinical-trial-matching/shared";

export async function searchClinicalTrials(
  _strategy: SearchStrategy,
): Promise<TrialCandidate[]> {
  throw new Error("searchClinicalTrials not implemented");
}
```

> Naming note: this tool function is `searchClinicalTrials` (not `searchTrials`) to avoid collision with the `searchTrials` node in `nodes/search-trials.ts`. The node will call this tool when implemented.

- [ ] **Step 2: Write `patient-loader.ts`**

`apps/agent/src/tools/patient-loader.ts`:
```ts
import type { PatientProfile } from "@clinical-trial-matching/shared";

export async function loadPatientBundle(_patientId: string): Promise<unknown> {
  throw new Error("loadPatientBundle not implemented");
}

export async function loadPatientProfile(_patientId: string): Promise<PatientProfile> {
  throw new Error("loadPatientProfile not implemented");
}
```

- [ ] **Step 3: Write `kg.ts`**

`apps/agent/src/tools/kg.ts`:
```ts
import neo4j, { type Driver } from "neo4j-driver";
import type {
  KGNode,
  KGPath,
  Mechanism,
  RepurposingCandidate,
} from "@clinical-trial-matching/shared";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (driver) return driver;
  const uri = process.env.NEO4J_URI;
  const username = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !username || !password) {
    throw new Error("NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD must be set");
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  return driver;
}

export async function pingKG(): Promise<boolean> {
  const session = getDriver().session({ database: process.env.NEO4J_DATABASE });
  try {
    await session.run("RETURN 1");
    return true;
  } finally {
    await session.close();
  }
}

export async function findGeneTargetsForDisease(
  _diseaseId: string,
): Promise<KGNode[]> {
  // TODO: Cypher MATCH (d:Disease {id:$id})-[:disease_protein]->(g:GeneProtein) RETURN g
  throw new Error("findGeneTargetsForDisease not implemented");
}

export async function findSharedPathways(
  _diseaseId: string,
  _depth: number,
): Promise<KGNode[]> {
  throw new Error("findSharedPathways not implemented");
}

export async function findDrugsTargetingPathways(
  _pathwayIds: string[],
): Promise<RepurposingCandidate[]> {
  throw new Error("findDrugsTargetingPathways not implemented");
}

export async function pathBetween(
  _fromId: string,
  _toId: string,
  _maxHops: number,
): Promise<KGPath[]> {
  throw new Error("pathBetween not implemented");
}

export async function buildMechanismsForConditions(
  _conditionIds: string[],
): Promise<Mechanism[]> {
  // TODO: orchestrates findGeneTargets + findSharedPathways into Mechanism[]
  throw new Error("buildMechanismsForConditions not implemented");
}
```

- [ ] **Step 4: Write `pubmed.ts`**

`apps/agent/src/tools/pubmed.ts`:
```ts
import type { Citation } from "@clinical-trial-matching/shared";

export async function searchPubMed(
  _query: string,
  _maxResults = 10,
): Promise<Citation[]> {
  // TODO: GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?... + efetch
  throw new Error("searchPubMed not implemented");
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/tools/
git commit -m "feat(agent): tool stubs (clinicaltrials, patient-loader, kg, pubmed)"
```

### Task 18: Prompt stubs

**Files:**
- Create: `apps/agent/src/prompts/extract-profile.ts`
- Create: `apps/agent/src/prompts/mechanism.ts`
- Create: `apps/agent/src/prompts/repurposing.ts`
- Create: `apps/agent/src/prompts/search-strategy.ts`
- Create: `apps/agent/src/prompts/pre-filter.ts`
- Create: `apps/agent/src/prompts/eligibility.ts`
- Create: `apps/agent/src/prompts/mechanism-plausibility.ts`
- Create: `apps/agent/src/prompts/literature-synthesis.ts`
- Create: `apps/agent/src/prompts/rank.ts`

- [ ] **Step 1: Write each prompt stub**

`apps/agent/src/prompts/extract-profile.ts`:
```ts
export function extractProfilePrompt(_fhirBundle: unknown): string {
  // TODO: implement prompt that extracts PatientProfile from FHIR bundle
  return "";
}
```

`apps/agent/src/prompts/mechanism.ts`:
```ts
import type { PatientProfile, Mechanism } from "@clinical-trial-matching/shared";

export function mechanismPrompt(
  _profile: PatientProfile,
  _kgFindings: Mechanism[],
): string {
  // TODO: prompt that summarizes KG findings into clinically meaningful mechanisms
  return "";
}
```

`apps/agent/src/prompts/repurposing.ts`:
```ts
import type { Mechanism, RepurposingCandidate } from "@clinical-trial-matching/shared";

export function repurposingPrompt(
  _mechanisms: Mechanism[],
  _candidates: RepurposingCandidate[],
): string {
  // TODO: prompt that articulates why each repurposing candidate is biologically plausible
  return "";
}
```

`apps/agent/src/prompts/search-strategy.ts`:
```ts
import type {
  PatientProfile,
  Mechanism,
  SearchStrategy,
} from "@clinical-trial-matching/shared";

export function searchStrategyPrompt(
  _profile: PatientProfile,
  _mechanisms: Mechanism[],
  _previousAttempt: SearchStrategy | null,
): string {
  // TODO: implement prompt that produces SearchStrategy using condition AND
  // mechanism terms; broadens if previousAttempt set. Repurposing candidate
  // drug names are queried separately in search-trials and unioned.
  return "";
}
```

`apps/agent/src/prompts/pre-filter.ts`:
```ts
import type { PatientProfile, TrialCandidate } from "@clinical-trial-matching/shared";

export function preFilterPrompt(_profile: PatientProfile, _candidate: TrialCandidate): string {
  // TODO: implement cheap pre-filter prompt — pass/fail with brief reason
  return "";
}
```

`apps/agent/src/prompts/eligibility.ts`:
```ts
import type { PatientProfile, TrialCandidate } from "@clinical-trial-matching/shared";

export function eligibilityPrompt(_profile: PatientProfile, _candidate: TrialCandidate): string {
  // TODO: per-criterion inclusion/exclusion analysis
  return "";
}
```

`apps/agent/src/prompts/mechanism-plausibility.ts`:
```ts
import type {
  PatientProfile,
  Mechanism,
  TrialCandidate,
  KGPath,
} from "@clinical-trial-matching/shared";

export function mechanismPlausibilityPrompt(
  _profile: PatientProfile,
  _candidate: TrialCandidate,
  _mechanisms: Mechanism[],
  _kgPaths: KGPath[],
): string {
  // TODO: explains whether the trial's intervention plausibly addresses the patient's mechanism
  return "";
}
```

`apps/agent/src/prompts/literature-synthesis.ts`:
```ts
import type { Citation, TrialCandidate } from "@clinical-trial-matching/shared";

export function literatureSynthesisPrompt(
  _candidate: TrialCandidate,
  _citations: Citation[],
): string {
  // TODO: synthesizes PubMed hits into a brief support/refute paragraph
  return "";
}
```

`apps/agent/src/prompts/rank.ts`:
```ts
import type { PatientProfile, TrialMatch } from "@clinical-trial-matching/shared";

export function rankPrompt(_profile: PatientProfile, _matches: TrialMatch[]): string {
  // TODO: implement final ranking + synthesis prompt combining eligibility, mechanism, evidence
  return "";
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/prompts/
git commit -m "feat(agent): prompt template stubs"
```

### Task 19: Node stub — `extract-patient-profile`

**Files:**
- Create: `apps/agent/src/nodes/extract-patient-profile.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/extract-patient-profile.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function extractPatientProfile(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: load FHIR bundle for state.patientId, call LLM with extractProfilePrompt,
  // validate with PatientProfileSchema, return { patientProfile }
  return { patientProfile: null };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/extract-patient-profile.ts
git commit -m "feat(agent): extract-patient-profile node stub"
```

### Task 19a: Node stub — `identify-relevant-mechanisms`

**Files:**
- Create: `apps/agent/src/nodes/identify-relevant-mechanisms.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/identify-relevant-mechanisms.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function identifyRelevantMechanisms(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: for each condition in state.patientProfile.conditions, call
  // kg.buildMechanismsForConditions(); LLM-summarize the most clinically relevant ones.
  return { mechanisms: [] };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/identify-relevant-mechanisms.ts
git commit -m "feat(agent): identify-relevant-mechanisms node stub"
```

### Task 19b: Node stub — `find-repurposing-candidates`

**Files:**
- Create: `apps/agent/src/nodes/find-repurposing-candidates.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/find-repurposing-candidates.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function findRepurposingCandidates(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: pathwayIds = mechanisms.flatMap(m => m.pathways.map(p => p.id));
  // kg.findDrugsTargetingPathways(pathwayIds); LLM-narrate rationale for each.
  return { repurposingCandidates: [] };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/find-repurposing-candidates.ts
git commit -m "feat(agent): find-repurposing-candidates node stub"
```

### Task 20: Node stub — `generate-search-strategy`

**Files:**
- Create: `apps/agent/src/nodes/generate-search-strategy.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/generate-search-strategy.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function generateSearchStrategy(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: call LLM with searchStrategyPrompt(state.patientProfile, state.searchStrategy);
  // increment attempts; if state.searchStrategy is non-null, broaden.
  return {
    searchStrategy: null,
    attempts: state.attempts + 1,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/generate-search-strategy.ts
git commit -m "feat(agent): generate-search-strategy node stub"
```

### Task 21: Node stub — `search-trials`

**Files:**
- Create: `apps/agent/src/nodes/search-trials.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/search-trials.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function searchTrials(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: two queries against clinicaltrials.searchClinicalTrials():
  //   (1) state.searchStrategy (condition + mechanism terms)
  //   (2) state.repurposingCandidates → query by intervention drug names
  // Union and dedupe by nctId; store in candidates.
  return { candidates: [] };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/search-trials.ts
git commit -m "feat(agent): search-trials node stub"
```

### Task 22: Node stub — `pre-filter`

**Files:**
- Create: `apps/agent/src/nodes/pre-filter.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/pre-filter.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function preFilter(
  _state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: cheap LLM-as-judge to drop obvious non-matches from candidates.
  return { candidates: [] };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/pre-filter.ts
git commit -m "feat(agent): pre-filter node stub"
```

### Task 23: Subgraph `trial-eval` — state + internal node stubs

**Files:**
- Create: `apps/agent/src/subgraphs/trial-eval/state.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/decide-if-more-evidence.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/graph.ts`

- [ ] **Step 1: Write subgraph state**

`apps/agent/src/subgraphs/trial-eval/state.ts`:
```ts
import { Annotation } from "@langchain/langgraph";
import type {
  PatientProfile,
  TrialCandidate,
  TrialMatch,
  Mechanism,
  RepurposingCandidate,
  Citation,
  EligibilityAssessment,
} from "@clinical-trial-matching/shared";

export const TrialEvalState = Annotation.Root({
  patientProfile: Annotation<PatientProfile>,
  candidate: Annotation<TrialCandidate>,
  mechanisms: Annotation<Mechanism[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  repurposingCandidates: Annotation<RepurposingCandidate[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  eligibility: Annotation<EligibilityAssessment | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  mechanismScore: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  mechanismRationale: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  literatureSupport: Annotation<Citation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  evidenceAttempts: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  match: Annotation<TrialMatch | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type TrialEvalStateType = typeof TrialEvalState.State;
```

- [ ] **Step 2: Write `eligibility-check.ts`**

`apps/agent/src/subgraphs/trial-eval/nodes/eligibility-check.ts`:
```ts
import type { TrialEvalStateType } from "../state.js";

export async function eligibilityCheck(
  _state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: per-criterion analysis with eligibilityPrompt
  return { eligibility: null };
}
```

- [ ] **Step 3: Write `mechanism-plausibility.ts`**

`apps/agent/src/subgraphs/trial-eval/nodes/mechanism-plausibility.ts`:
```ts
import type { TrialEvalStateType } from "../state.js";

export async function mechanismPlausibility(
  _state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: kg.pathBetween(intervention, condition) for each pair; LLM scores plausibility.
  return { mechanismScore: null, mechanismRationale: null };
}
```

- [ ] **Step 4: Write `literature-support.ts`**

`apps/agent/src/subgraphs/trial-eval/nodes/literature-support.ts`:
```ts
import type { TrialEvalStateType } from "../state.js";

export async function literatureSupport(
  state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: pubmed.searchPubMed(query derived from trial + mechanism);
  // broaden query on subsequent evidenceAttempts.
  return {
    literatureSupport: [],
    evidenceAttempts: state.evidenceAttempts + 1,
  };
}
```

- [ ] **Step 5: Write `decide-if-more-evidence.ts`**

`apps/agent/src/subgraphs/trial-eval/nodes/decide-if-more-evidence.ts`:
```ts
import type { TrialEvalStateType } from "../state.js";

const MIN_CITATIONS = 3;
const MAX_EVIDENCE_ATTEMPTS = 2;

export function decideIfMoreEvidence(
  state: TrialEvalStateType,
): "literature-support" | "synthesize-match" {
  const needMore =
    state.literatureSupport.length < MIN_CITATIONS &&
    state.evidenceAttempts < MAX_EVIDENCE_ATTEMPTS;
  return needMore ? "literature-support" : "synthesize-match";
}
```

- [ ] **Step 6: Write `synthesize-match.ts`**

`apps/agent/src/subgraphs/trial-eval/nodes/synthesize-match.ts`:
```ts
import type { TrialEvalStateType } from "../state.js";

export async function synthesizeMatch(
  _state: TrialEvalStateType,
): Promise<Partial<TrialEvalStateType>> {
  // TODO: combine eligibility + mechanism + literature into a TrialMatch with score.
  return { match: null };
}
```

- [ ] **Step 7: Write subgraph wiring**

`apps/agent/src/subgraphs/trial-eval/graph.ts`:
```ts
import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState } from "./state.js";
import { eligibilityCheck } from "./nodes/eligibility-check.js";
import { mechanismPlausibility } from "./nodes/mechanism-plausibility.js";
import { literatureSupport } from "./nodes/literature-support.js";
import { decideIfMoreEvidence } from "./nodes/decide-if-more-evidence.js";
import { synthesizeMatch } from "./nodes/synthesize-match.js";

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("eligibility-check", eligibilityCheck)
  .addNode("mechanism-plausibility", mechanismPlausibility)
  .addNode("literature-support", literatureSupport)
  .addNode("synthesize-match", synthesizeMatch)
  .addEdge(START, "eligibility-check")
  .addEdge("eligibility-check", "mechanism-plausibility")
  .addEdge("mechanism-plausibility", "literature-support")
  .addConditionalEdges("literature-support", decideIfMoreEvidence, [
    "literature-support",
    "synthesize-match",
  ])
  .addEdge("synthesize-match", END)
  .compile();
```

> Cycle note: `decideIfMoreEvidence` returns `"literature-support"` (loop back) or `"synthesize-match"` (proceed). The `evidenceAttempts` counter prevents infinite loops.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/
git commit -m "feat(agent): trial-eval subgraph with evidence-fetch cycle"
```

### Task 24: Routing function — `route-after-pre-filter`

**Files:**
- Create: `apps/agent/src/nodes/route-after-pre-filter.ts`

> Design note: in LangGraph.js, "fan out" is not a graph node — it's the return value of a conditional-edge routing function. Returning `Send[]` from the router dispatches parallel invocations of the target subgraph. This single function handles both branches the spec calls out: the broaden-and-retry loop (`generate-search-strategy`) and the fan-out (`trial-eval-subgraph`).

- [ ] **Step 1: Write routing function**

`apps/agent/src/nodes/route-after-pre-filter.ts`:
```ts
import { Send } from "@langchain/langgraph";
import type { AgentStateType } from "../state.js";

const MIN_CANDIDATES = 5;
const MAX_ATTEMPTS = 3;

export function routeAfterPreFilter(
  state: AgentStateType,
): "generate-search-strategy" | Send[] {
  const shouldBroaden =
    state.candidates.length < MIN_CANDIDATES && state.attempts < MAX_ATTEMPTS;

  if (shouldBroaden) {
    return "generate-search-strategy";
  }

  if (!state.patientProfile) {
    throw new Error("patientProfile must be set before fan-out");
  }

  const profile = state.patientProfile;
  const mechanisms = state.mechanisms;
  const repurposingCandidates = state.repurposingCandidates;
  return state.candidates.map(
    (candidate) =>
      new Send("trial-eval-subgraph", {
        patientProfile: profile,
        candidate,
        mechanisms,
        repurposingCandidates,
      }),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/route-after-pre-filter.ts
git commit -m "feat(agent): route-after-pre-filter (broaden or fan-out)"
```

### Task 25: Node stub — `rank-and-synthesize`

**Files:**
- Create: `apps/agent/src/nodes/rank-and-synthesize.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/rank-and-synthesize.ts`:
```ts
import type { AgentStateType } from "../state.js";

export async function rankAndSynthesize(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // TODO: call LLM with rankPrompt(state.patientProfile, state.matches);
  // re-order matches; produce approvalRequest summary.
  return {
    matches: state.matches,
    approvalRequest: null,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/rank-and-synthesize.ts
git commit -m "feat(agent): rank-and-synthesize node stub"
```

### Task 26: Node stub — `human-approval`

**Files:**
- Create: `apps/agent/src/nodes/human-approval.ts`

- [ ] **Step 1: Write node**

`apps/agent/src/nodes/human-approval.ts`:
```ts
import { interrupt } from "@langchain/langgraph";
import type { ApprovalResponse } from "@clinical-trial-matching/shared";
import type { AgentStateType } from "../state.js";

export async function humanApproval(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const response = interrupt<typeof state.approvalRequest, ApprovalResponse>(
    state.approvalRequest,
  );

  if (response.action === "reject") {
    return { matches: [], error: response.notes ?? "rejected by reviewer" };
  }

  if (response.action === "edit" && response.edits) {
    return { matches: response.edits };
  }

  return {};
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/nodes/human-approval.ts
git commit -m "feat(agent): human-approval interrupt node"
```

### Task 27: `apps/agent/src/graph.ts` — main graph wiring

**Files:**
- Create: `apps/agent/src/graph.ts`

- [ ] **Step 1: Write graph**

`apps/agent/src/graph.ts`:
```ts
import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state.js";
import { extractPatientProfile } from "./nodes/extract-patient-profile.js";
import { identifyRelevantMechanisms } from "./nodes/identify-relevant-mechanisms.js";
import { findRepurposingCandidates } from "./nodes/find-repurposing-candidates.js";
import { generateSearchStrategy } from "./nodes/generate-search-strategy.js";
import { searchTrials } from "./nodes/search-trials.js";
import { preFilter } from "./nodes/pre-filter.js";
import { routeAfterPreFilter } from "./nodes/route-after-pre-filter.js";
import { rankAndSynthesize } from "./nodes/rank-and-synthesize.js";
import { humanApproval } from "./nodes/human-approval.js";
import { trialEvalGraph } from "./subgraphs/trial-eval/graph.js";

export const graph = new StateGraph(AgentState)
  .addNode("extract-patient-profile", extractPatientProfile)
  .addNode("identify-relevant-mechanisms", identifyRelevantMechanisms)
  .addNode("find-repurposing-candidates", findRepurposingCandidates)
  .addNode("generate-search-strategy", generateSearchStrategy)
  .addNode("search-trials", searchTrials)
  .addNode("pre-filter", preFilter)
  .addNode("trial-eval-subgraph", trialEvalGraph)
  .addNode("rank-and-synthesize", rankAndSynthesize)
  .addNode("human-approval", humanApproval)
  .addEdge(START, "extract-patient-profile")
  .addEdge("extract-patient-profile", "identify-relevant-mechanisms")
  .addEdge("identify-relevant-mechanisms", "find-repurposing-candidates")
  .addEdge("identify-relevant-mechanisms", "generate-search-strategy")
  .addEdge("find-repurposing-candidates", "search-trials")
  .addEdge("generate-search-strategy", "search-trials")
  .addEdge("search-trials", "pre-filter")
  .addConditionalEdges("pre-filter", routeAfterPreFilter, [
    "generate-search-strategy",
    "trial-eval-subgraph",
  ])
  .addEdge("trial-eval-subgraph", "rank-and-synthesize")
  .addEdge("rank-and-synthesize", "human-approval")
  .addEdge("human-approval", END)
  .compile();
```

> Routing notes:
> - `identify-relevant-mechanisms` fans out to `find-repurposing-candidates` and `generate-search-strategy` in parallel. Both terminate at `search-trials`, which LangGraph implicitly joins (waits for both predecessors).
> - `generate-search-strategy` does NOT depend on `find-repurposing-candidates`. The search strategy uses condition + mechanism terms; `search-trials` then issues two queries (condition-based and drug-name-based) and unions the results.
> - `routeAfterPreFilter` returns either the string `"generate-search-strategy"` (broaden-and-retry loop) or `Send[]` targeting `"trial-eval-subgraph"` (parallel fan-out). The third argument to `addConditionalEdges` is the list of *possible* downstream node names — used for graph visualization, not for runtime selection.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter agent typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/graph.ts
git commit -m "feat(agent): wire main StateGraph with stub nodes"
```

### Task 28: `apps/agent/langgraph.json`

**Files:**
- Create: `apps/agent/langgraph.json`

- [ ] **Step 1: Write `langgraph.json`**

`apps/agent/langgraph.json`:
```json
{
  "node_version": "20",
  "graphs": {
    "clinical_trial_matching": "./src/graph.ts:graph"
  },
  "env": ".env"
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/langgraph.json
git commit -m "chore(agent): langgraph.json deploy config"
```

### Task 29: Verify `langgraph dev` boots the agent

- [ ] **Step 1: Set OPENROUTER_API_KEY in env**

```bash
cp apps/agent/.env.example apps/agent/.env
# manually edit apps/agent/.env and set OPENROUTER_API_KEY=<your key>
# (and NEO4J_PASSWORD if you've already done Task 42a)
```

- [ ] **Step 2: Start the agent dev server**

Run (from repo root): `pnpm dev:agent`
Expected output (within ~10s): server listening on `http://localhost:2024`, Studio URL printed.

- [ ] **Step 3: Verify graph is loaded**

In another terminal:
```bash
curl -s http://localhost:2024/assistants | head
```
Expected: JSON response listing the `clinical_trial_matching` assistant.

- [ ] **Step 4: Kill the dev server (Ctrl+C in step 2 terminal). No commit needed — verification only.**

---

## Phase 4: `apps/web/`

### Task 30: `apps/web/` package + Next config

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/.env.example`

- [ ] **Step 1: Write `apps/web/package.json`**

`apps/web/package.json`:
```json
{
  "name": "web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "next lint"
  },
  "dependencies": {
    "@clinical-trial-matching/shared": "workspace:*",
    "@langchain/langgraph-sdk": "1.9.4",
    "next": "16.2.6",
    "react": "19.2.6",
    "react-dom": "19.2.6",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "lucide-react": "1.16.0",
    "tailwind-merge": "3.6.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "4.3.0",
    "@types/node": "20.19.41",
    "@types/react": "19.2.15",
    "@types/react-dom": "19.2.3",
    "autoprefixer": "10.5.0",
    "postcss": "8.5.15",
    "tailwindcss": "4.3.0",
    "typescript": "6.0.3",
    "eslint": "10.4.0",
    "eslint-config-next": "16.2.6"
  }
}
```

> Versions verified against the npm registry at write-time. Re-run `npm view <pkg> version` if reviewing this plan months later — bump if newer stable releases exist, but spot-check breaking-change notes for major bumps (Next, React, LangGraph, Tailwind).

- [ ] **Step 2: Write `apps/web/tsconfig.json`**

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] },
    "noEmit": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write `apps/web/next.config.ts`**

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@clinical-trial-matching/shared"],
};

export default nextConfig;
```

- [ ] **Step 4: Write `apps/web/.env.example`**

`apps/web/.env.example`:
```
LANGGRAPH_API_URL=http://localhost:2024
LANGGRAPH_API_KEY=
```

- [ ] **Step 5: Install**

Run: `pnpm install`
Expected: Next.js and deps install.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/next.config.ts apps/web/.env.example pnpm-lock.yaml
git commit -m "chore(web): scaffold Next.js package"
```

### Task 31: Tailwind 4 + shadcn config

**Files:**
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/components.json`
- Create: `apps/web/src/app/globals.css`

> Tailwind v4 changes: no JS/TS `tailwind.config.ts` required — config is CSS-first via `@theme` directives. PostCSS plugin renamed to `@tailwindcss/postcss`. Single `@import "tailwindcss";` replaces the three `@tailwind` directives. `content` paths are auto-detected; override via `@source` in CSS if needed.

- [ ] **Step 1: Write `postcss.config.mjs`**

`apps/web/postcss.config.mjs`:
```js
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
```

> Tailwind v4 no longer needs Autoprefixer — it ships built-in. We still pin `autoprefixer` in `package.json` because `eslint-config-next` lists it transitively; safe to remove if Next stops requiring it.

- [ ] **Step 2: Write `components.json`**

`apps/web/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib"
  }
}
```

> `tailwind.config` is empty string — shadcn's v4 setup expects no JS config file.

- [ ] **Step 3: Write `globals.css`**

`apps/web/src/app/globals.css`:
```css
@import "tailwindcss";

/* Tailwind v4 theme tokens. Extend here when shadcn primitives require
   CSS variables for color tokens (e.g. --color-primary). For the
   skeleton we keep this minimal — shadcn `add` commands will append
   the variables they need. */
@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/postcss.config.mjs apps/web/components.json apps/web/src/app/globals.css
git commit -m "chore(web): tailwind v4 + shadcn config"
```

### Task 32: `apps/web/src/lib/` files

**Files:**
- Create: `apps/web/src/lib/utils.ts`
- Create: `apps/web/src/lib/langgraph.ts`
- Create: `apps/web/src/lib/patients-loader.ts`
- Create: `apps/web/src/lib/types.ts`

- [ ] **Step 1: Write `utils.ts` (shadcn helper)**

`apps/web/src/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Write `langgraph.ts`**

`apps/web/src/lib/langgraph.ts`:
```ts
import { Client } from "@langchain/langgraph-sdk";

const apiUrl = process.env.LANGGRAPH_API_URL;
const apiKey = process.env.LANGGRAPH_API_KEY;

if (!apiUrl) {
  throw new Error("LANGGRAPH_API_URL is not set");
}

export const langgraph = new Client({
  apiUrl,
  apiKey: apiKey || undefined,
});

export const GRAPH_ID = "clinical_trial_matching";
```

- [ ] **Step 3: Write `patients-loader.ts` (stub)**

`apps/web/src/lib/patients-loader.ts`:
```ts
import "server-only";
import type { PatientProfile } from "@clinical-trial-matching/shared";

export async function listPatients(): Promise<Array<{ id: string; displayName: string }>> {
  // TODO: read data/patients/*.json, return id + displayName for each.
  return [];
}

export async function getPatient(_patientId: string): Promise<PatientProfile | null> {
  // TODO: read data/patients/<id>.json, parse with PatientProfileSchema.
  return null;
}
```

- [ ] **Step 4: Write `types.ts`**

`apps/web/src/lib/types.ts`:
```ts
export * from "@clinical-trial-matching/shared";
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/
git commit -m "feat(web): lib stubs (utils, langgraph, patients-loader, types)"
```

### Task 33: One shadcn primitive — `Button`

**Files:**
- Create: `apps/web/src/components/ui/button.tsx`

- [ ] **Step 1: Write Button**

`apps/web/src/components/ui/button.tsx`:
```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-neutral-900 text-white hover:bg-neutral-800",
        outline: "border border-neutral-300 hover:bg-neutral-100",
        ghost: "hover:bg-neutral-100",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ui/button.tsx
git commit -m "feat(web): Button primitive"
```

### Task 34: Layout components — sidebar + header

**Files:**
- Create: `apps/web/src/components/patient-sidebar.tsx`
- Create: `apps/web/src/components/patient-header.tsx`
- Create: `apps/web/src/components/match-history-list.tsx`

- [ ] **Step 1: Write `patient-sidebar.tsx`**

`apps/web/src/components/patient-sidebar.tsx`:
```tsx
import Link from "next/link";
import { listPatients } from "@/lib/patients-loader";

export async function PatientSidebar() {
  const patients = await listPatients();
  return (
    <aside className="w-64 border-r border-neutral-200 p-4">
      <h2 className="text-sm font-semibold uppercase text-neutral-500 mb-2">Patients</h2>
      <ul className="space-y-1">
        {patients.length === 0 && (
          <li className="text-sm text-neutral-400">No patients yet.</li>
        )}
        {patients.map((p) => (
          <li key={p.id}>
            <Link
              href={`/patients/${p.id}`}
              className="block rounded px-2 py-1 text-sm hover:bg-neutral-100"
            >
              {p.displayName}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 2: Write `patient-header.tsx`**

`apps/web/src/components/patient-header.tsx`:
```tsx
import type { PatientProfile } from "@/lib/types";

export function PatientHeader({ patient }: { patient: PatientProfile }) {
  return (
    <header className="border-b border-neutral-200 pb-4 mb-6">
      <h1 className="text-2xl font-semibold">{patient.displayName}</h1>
      <p className="text-sm text-neutral-500">
        {patient.ageYears}y · {patient.sex}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {patient.conditions.map((c) => (
          <span
            key={c.code}
            className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs"
          >
            {c.display}
          </span>
        ))}
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Write `match-history-list.tsx`**

`apps/web/src/components/match-history-list.tsx`:
```tsx
export function MatchHistoryList({ patientId: _patientId }: { patientId: string }) {
  // TODO: fetch threads from /api/patients/[patientId]/runs, render list.
  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">Match history</h2>
      <p className="text-sm text-neutral-500">No prior runs.</p>
    </section>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/patient-sidebar.tsx apps/web/src/components/patient-header.tsx apps/web/src/components/match-history-list.tsx
git commit -m "feat(web): sidebar, patient header, match history stubs"
```

### Task 35: Run-view components

**Files:**
- Create: `apps/web/src/components/run-view/index.tsx`
- Create: `apps/web/src/components/run-view/graph-timeline.tsx`
- Create: `apps/web/src/components/run-view/reasoning-trace.tsx`
- Create: `apps/web/src/components/run-view/mechanisms-panel.tsx`
- Create: `apps/web/src/components/run-view/candidates-panel.tsx`
- Create: `apps/web/src/components/run-view/approval-panel.tsx`

- [ ] **Step 1: Write `graph-timeline.tsx`**

`apps/web/src/components/run-view/graph-timeline.tsx`:
```tsx
"use client";

const NODES = [
  "extract-patient-profile",
  "identify-relevant-mechanisms",
  "find-repurposing-candidates",
  "generate-search-strategy",
  "search-trials",
  "pre-filter",
  "trial-eval-subgraph",
  "rank-and-synthesize",
  "human-approval",
] as const;

export function GraphTimeline({ activeNode }: { activeNode: string | null }) {
  return (
    <ol className="space-y-1 text-sm">
      {NODES.map((node) => (
        <li
          key={node}
          className={node === activeNode ? "font-semibold text-blue-600" : "text-neutral-600"}
        >
          {node}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 2: Write `reasoning-trace.tsx`**

`apps/web/src/components/run-view/reasoning-trace.tsx`:
```tsx
"use client";

export function ReasoningTrace({ messages: _messages }: { messages: unknown[] }) {
  // TODO: render streamed LLM messages per node, scrollable.
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">Reasoning</h3>
      <p className="text-sm text-neutral-500">Live trace will stream here.</p>
    </section>
  );
}
```

- [ ] **Step 3: Write `mechanisms-panel.tsx`**

`apps/web/src/components/run-view/mechanisms-panel.tsx`:
```tsx
"use client";
import type { Mechanism, RepurposingCandidate } from "@/lib/types";

export function MechanismsPanel({
  mechanisms,
  repurposingCandidates,
}: {
  mechanisms: Mechanism[];
  repurposingCandidates: RepurposingCandidate[];
}) {
  // TODO: render mechanisms (genes/pathways per condition) and repurposing candidates.
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">
        Mechanisms ({mechanisms.length}) · Repurposing ({repurposingCandidates.length})
      </h3>
      <p className="text-sm text-neutral-500">
        KG-derived mechanism findings will appear here.
      </p>
    </section>
  );
}
```

- [ ] **Step 4: Write `candidates-panel.tsx`**

`apps/web/src/components/run-view/candidates-panel.tsx`:
```tsx
"use client";
import type { TrialCandidate, TrialMatch } from "@/lib/types";

export function CandidatesPanel({
  candidates,
  matches,
}: {
  candidates: TrialCandidate[];
  matches: TrialMatch[];
}) {
  // TODO: render candidates / matches as they update; surface
  // mechanism score and repurposing badge per match.
  return (
    <section>
      <h3 className="text-sm font-semibold mb-2">
        Candidates ({candidates.length}) · Matches ({matches.length})
      </h3>
      <p className="text-sm text-neutral-500">Trials will appear here as they're evaluated.</p>
    </section>
  );
}
```

- [ ] **Step 5: Write `approval-panel.tsx`**

`apps/web/src/components/run-view/approval-panel.tsx`:
```tsx
"use client";
import { Button } from "@/components/ui/button";
import type { ApprovalRequest } from "@/lib/types";

export function ApprovalPanel({
  request: _request,
  threadId: _threadId,
}: {
  request: ApprovalRequest;
  threadId: string;
}) {
  // TODO: POST to /api/runs/[threadId]/resume on approve/reject/edit.
  return (
    <section className="rounded border border-amber-300 bg-amber-50 p-4">
      <h3 className="font-semibold mb-2">Review matches</h3>
      <p className="text-sm text-neutral-700 mb-3">
        The agent is waiting for your approval.
      </p>
      <div className="flex gap-2">
        <Button>Approve</Button>
        <Button variant="outline">Edit</Button>
        <Button variant="ghost">Reject</Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Write `run-view/index.tsx`**

`apps/web/src/components/run-view/index.tsx`:
```tsx
"use client";
import { GraphTimeline } from "./graph-timeline";
import { ReasoningTrace } from "./reasoning-trace";
import { MechanismsPanel } from "./mechanisms-panel";
import { CandidatesPanel } from "./candidates-panel";

export function RunView({ threadId: _threadId }: { threadId: string }) {
  // TODO: open SSE stream to /api/runs/[threadId]/stream;
  // dispatch updates/values/messages to child panels.
  return (
    <div className="grid grid-cols-[220px_1fr] gap-6">
      <GraphTimeline activeNode={null} />
      <div className="space-y-6">
        <MechanismsPanel mechanisms={[]} repurposingCandidates={[]} />
        <ReasoningTrace messages={[]} />
        <CandidatesPanel candidates={[]} matches={[]} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/run-view/
git commit -m "feat(web): run-view component stubs"
```

### Task 36: Chat placeholder component

**Files:**
- Create: `apps/web/src/components/chat/placeholder.tsx`

- [ ] **Step 1: Write `placeholder.tsx`**

`apps/web/src/components/chat/placeholder.tsx`:
```tsx
export function ChatPlaceholder() {
  return (
    <div className="rounded border border-dashed border-neutral-300 p-8 text-center text-neutral-500">
      <p className="text-lg">Chat coming soon</p>
      <p className="text-sm mt-1">
        Discuss the trials matched for this patient with the assistant.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/chat/placeholder.tsx
git commit -m "feat(web): chat placeholder"
```

### Task 37: App router pages

**Files:**
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/patients/[patientId]/layout.tsx`
- Create: `apps/web/src/app/patients/[patientId]/page.tsx`
- Create: `apps/web/src/app/patients/[patientId]/runs/[threadId]/page.tsx`
- Create: `apps/web/src/app/patients/[patientId]/chat/page.tsx`

- [ ] **Step 1: Write root `layout.tsx`**

`apps/web/src/app/layout.tsx`:
```tsx
import "./globals.css";
import type { ReactNode } from "react";
import { PatientSidebar } from "@/components/patient-sidebar";

export const metadata = {
  title: "Clinical Trial Matching",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex">
        <PatientSidebar />
        <main className="flex-1 p-6">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Write root `page.tsx`**

`apps/web/src/app/page.tsx`:
```tsx
export default function HomePage() {
  return (
    <div className="text-neutral-500">
      <p>Select a patient from the sidebar to begin.</p>
    </div>
  );
}
```

- [ ] **Step 3: Write patient `layout.tsx`**

`apps/web/src/app/patients/[patientId]/layout.tsx`:
```tsx
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getPatient } from "@/lib/patients-loader";
import { PatientHeader } from "@/components/patient-header";

export default async function PatientLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  const patient = await getPatient(patientId);
  if (!patient) return notFound();
  return (
    <div>
      <PatientHeader patient={patient} />
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Write patient `page.tsx`**

`apps/web/src/app/patients/[patientId]/page.tsx`:
```tsx
import { Button } from "@/components/ui/button";
import { MatchHistoryList } from "@/components/match-history-list";

export default async function PatientPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  return (
    <div className="space-y-6">
      <div>
        <Button>Run new match</Button>
      </div>
      <MatchHistoryList patientId={patientId} />
    </div>
  );
}
```

- [ ] **Step 5: Write run `page.tsx`**

`apps/web/src/app/patients/[patientId]/runs/[threadId]/page.tsx`:
```tsx
import { RunView } from "@/components/run-view";

export default async function RunPage({
  params,
}: {
  params: Promise<{ patientId: string; threadId: string }>;
}) {
  const { threadId } = await params;
  return <RunView threadId={threadId} />;
}
```

- [ ] **Step 6: Write chat `page.tsx`**

`apps/web/src/app/patients/[patientId]/chat/page.tsx`:
```tsx
import { ChatPlaceholder } from "@/components/chat/placeholder";

export default function ChatPage() {
  return <ChatPlaceholder />;
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/
git commit -m "feat(web): app router pages and layouts"
```

### Task 38: API routes — patients

**Files:**
- Create: `apps/web/src/app/api/patients/route.ts`
- Create: `apps/web/src/app/api/patients/[patientId]/route.ts`

- [ ] **Step 1: Write `api/patients/route.ts`**

`apps/web/src/app/api/patients/route.ts`:
```ts
import { NextResponse } from "next/server";
import { listPatients } from "@/lib/patients-loader";

export async function GET() {
  const patients = await listPatients();
  return NextResponse.json({ patients });
}
```

- [ ] **Step 2: Write `api/patients/[patientId]/route.ts`**

`apps/web/src/app/api/patients/[patientId]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getPatient } from "@/lib/patients-loader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ patientId: string }> },
) {
  const { patientId } = await params;
  const patient = await getPatient(patientId);
  if (!patient) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ patient });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/patients/
git commit -m "feat(web): patient API routes"
```

### Task 39: API routes — runs

**Files:**
- Create: `apps/web/src/app/api/patients/[patientId]/runs/route.ts`
- Create: `apps/web/src/app/api/runs/[threadId]/stream/route.ts`
- Create: `apps/web/src/app/api/runs/[threadId]/state/route.ts`
- Create: `apps/web/src/app/api/runs/[threadId]/history/route.ts`
- Create: `apps/web/src/app/api/runs/[threadId]/resume/route.ts`

- [ ] **Step 1: Write `api/patients/[patientId]/runs/route.ts`**

`apps/web/src/app/api/patients/[patientId]/runs/route.ts`:
```ts
import { NextResponse } from "next/server";
import { GRAPH_ID, langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ patientId: string }> },
) {
  const { patientId } = await params;
  const threads = await langgraph.threads.search({
    metadata: { patientId },
    limit: 50,
  });
  return NextResponse.json({ threads });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ patientId: string }> },
) {
  const { patientId } = await params;
  const thread = await langgraph.threads.create({ metadata: { patientId } });
  const run = await langgraph.runs.create(thread.thread_id, GRAPH_ID, {
    input: { patientId },
  });
  return NextResponse.json({ threadId: thread.thread_id, runId: run.run_id });
}
```

- [ ] **Step 2: Write `api/runs/[threadId]/stream/route.ts`**

`apps/web/src/app/api/runs/[threadId]/stream/route.ts`:
```ts
import { GRAPH_ID, langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of langgraph.runs.stream(threadId, GRAPH_ID, {
          streamMode: ["values", "updates", "messages"],
        })) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 3: Write `api/runs/[threadId]/state/route.ts`**

`apps/web/src/app/api/runs/[threadId]/state/route.ts`:
```ts
import { NextResponse } from "next/server";
import { langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const state = await langgraph.threads.getState(threadId);
  return NextResponse.json({ state });
}
```

- [ ] **Step 4: Write `api/runs/[threadId]/history/route.ts`**

`apps/web/src/app/api/runs/[threadId]/history/route.ts`:
```ts
import { NextResponse } from "next/server";
import { langgraph } from "@/lib/langgraph";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const history = await langgraph.threads.getHistory(threadId);
  return NextResponse.json({ history });
}
```

- [ ] **Step 5: Write `api/runs/[threadId]/resume/route.ts`**

`apps/web/src/app/api/runs/[threadId]/resume/route.ts`:
```ts
import { NextResponse } from "next/server";
import { GRAPH_ID, langgraph } from "@/lib/langgraph";
import type { ApprovalResponse } from "@/lib/types";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await params;
  const body = (await req.json()) as ApprovalResponse;
  const run = await langgraph.runs.create(threadId, GRAPH_ID, {
    command: { resume: body },
  });
  return NextResponse.json({ runId: run.run_id });
}
```

- [ ] **Step 6: Typecheck web**

Run: `pnpm --filter web typecheck`
Expected: PASS.

> **NOTE:** the LangGraph SDK API surface for `runs.stream`, `runs.create({ command })`, and `threads.search({ metadata })` may have evolved by the time you read this. If typecheck flags any of these, consult `node_modules/@langchain/langgraph-sdk/dist` for the current method signatures and adjust. The shapes here reflect 0.0.32.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/api/
git commit -m "feat(web): run API routes (stream, state, history, resume)"
```

---

## Phase 5: Data + scripts

### Task 40: Sample patient FHIR bundles

**Files:**
- Create: `data/patients/patient-1.json`
- Create: `data/patients/patient-2.json`
- Create: `data/patients/patient-3.json`

> **NOTE:** These are minimal placeholder FHIR bundles, not real Synthea output. Replace with Synthea-generated bundles by running `pnpm patients:generate` once Java is installed. The shape below is intentionally tiny — just enough that `patients-loader` can be implemented later against a real Bundle structure.

- [ ] **Step 1: Write `patient-1.json`**

`data/patients/patient-1.json`:
```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    {
      "resource": {
        "resourceType": "Patient",
        "id": "patient-1",
        "name": [{ "given": ["Jane"], "family": "Doe" }],
        "gender": "female",
        "birthDate": "1965-04-12"
      }
    }
  ]
}
```

- [ ] **Step 2: Write `patient-2.json`**

`data/patients/patient-2.json`:
```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    {
      "resource": {
        "resourceType": "Patient",
        "id": "patient-2",
        "name": [{ "given": ["Robert"], "family": "Smith" }],
        "gender": "male",
        "birthDate": "1958-09-23"
      }
    }
  ]
}
```

- [ ] **Step 3: Write `patient-3.json`**

`data/patients/patient-3.json`:
```json
{
  "resourceType": "Bundle",
  "type": "collection",
  "entry": [
    {
      "resource": {
        "resourceType": "Patient",
        "id": "patient-3",
        "name": [{ "given": ["Maria"], "family": "Garcia" }],
        "gender": "female",
        "birthDate": "1972-01-30"
      }
    }
  ]
}
```

- [ ] **Step 4: Commit**

```bash
git add data/patients/
git commit -m "data: minimal sample FHIR bundles"
```

### Task 41: Synthea runner script

**Files:**
- Create: `scripts/generate-patients.sh`
- Create: `scripts/README.md`

- [ ] **Step 1: Write `generate-patients.sh`**

`scripts/generate-patients.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Generates synthetic FHIR patient bundles using Synthea and copies them to data/patients/.
# Requires Java 11+.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYNTHEA_DIR="${REPO_ROOT}/.synthea"
OUT_DIR="${REPO_ROOT}/data/patients"
N_PATIENTS="${1:-10}"

if ! command -v java >/dev/null 2>&1; then
  echo "Error: Java is not installed. Install Java 11+ first." >&2
  exit 1
fi

if [ ! -d "${SYNTHEA_DIR}" ]; then
  echo "Cloning Synthea..."
  git clone --depth 1 https://github.com/synthetichealth/synthea.git "${SYNTHEA_DIR}"
fi

cd "${SYNTHEA_DIR}"
./run_synthea -p "${N_PATIENTS}"

mkdir -p "${OUT_DIR}"
cp "${SYNTHEA_DIR}"/output/fhir/*.json "${OUT_DIR}/"

echo "Generated ${N_PATIENTS} patients into ${OUT_DIR}"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/generate-patients.sh`
Expected: no output.

- [ ] **Step 3: Write `scripts/README.md`**

`scripts/README.md`:
````markdown
# Scripts

## generate-patients.sh

Generates synthetic FHIR patient bundles via [Synthea](https://github.com/synthetichealth/synthea).

**Requires:** Java 11+

```bash
pnpm patients:generate          # 10 patients (default)
pnpm patients:generate -- 50    # 50 patients
```

Output lands in `data/patients/`. The script clones Synthea into `.synthea/` on first run (gitignored).

## build-primekg-subset.ts

Downloads PrimeKG node and edge CSVs from Harvard Dataverse (~600 MB total), filters to the prototype subset (drug, disease, gene/protein, biological_process), and writes filtered CSVs to `data/kg/`.

```bash
pnpm kg:build-subset
```

`data/kg/` is gitignored — re-run this script on a fresh clone.

## load-primekg-to-neo4j.cypher

Bulk-loads the filtered CSVs from `data/kg/` into a local Neo4j instance using `LOAD CSV WITH HEADERS`. Creates uniqueness constraints on node `id` and indexes on `name`, `type` before loading.

Prereqs:
- Neo4j running locally (Neo4j Desktop or `docker run neo4j`).
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` set in shell (or in `apps/agent/.env` and exported).
- `cypher-shell` on PATH (ships with Neo4j Desktop and the official Docker image).
- Filtered CSVs already in `data/kg/` (run `pnpm kg:build-subset` first).

```bash
pnpm kg:load
```
````

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-patients.sh scripts/README.md
git commit -m "chore: Synthea runner script and scripts README"
```

### Task 41a: PrimeKG subset builder

**Files:**
- Create: `scripts/build-primekg-subset.ts`
- Modify: root `package.json` to add `tsx` devDependency

- [ ] **Step 1: Add `tsx` to root `package.json` devDependencies**

In root `package.json`, add `"tsx": "4.22.3"` to `devDependencies`. The full block should become:
```json
"devDependencies": {
  "prettier": "3.8.3",
  "tsx": "4.22.3",
  "typescript": "6.0.3"
}
```

Then: `pnpm install` (from repo root)
Expected: tsx installed.

- [ ] **Step 2: Write `build-primekg-subset.ts`**

`scripts/build-primekg-subset.ts`:
```ts
#!/usr/bin/env tsx
/* eslint-disable no-console */
import { mkdir, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

// PrimeKG raw CSVs on Harvard Dataverse. Update DOIs if Harvard moves files.
const NODES_URL =
  "https://dataverse.harvard.edu/api/access/datafile/6180617";
const EDGES_URL =
  "https://dataverse.harvard.edu/api/access/datafile/6180616";

const KEPT_NODE_TYPES = new Set([
  "drug",
  "disease",
  "gene/protein",
  "biological_process",
]);

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "data/kg/raw");
const OUT_DIR = path.join(REPO_ROOT, "data/kg");

async function download(url: string, destPath: string) {
  if (existsSync(destPath)) {
    console.log(`exists, skipping: ${destPath}`);
    return;
  }
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await finished(
    Readable.fromWeb(res.body as never).pipe(createWriteStream(destPath)),
  );
}

async function filterNodes(srcPath: string, destPath: string): Promise<Set<string>> {
  const keptIds = new Set<string>();
  const out = createWriteStream(destPath);
  const rl = createInterface({ input: createReadStream(srcPath) });
  let header: string[] | null = null;
  let typeIdx = -1;
  let idIdx = -1;
  for await (const line of rl) {
    const cols = line.split(",");
    if (!header) {
      header = cols;
      typeIdx = header.indexOf("node_type");
      idIdx = header.indexOf("node_index");
      out.write(line + "\n");
      continue;
    }
    if (KEPT_NODE_TYPES.has(cols[typeIdx]!)) {
      keptIds.add(cols[idIdx]!);
      out.write(line + "\n");
    }
  }
  out.end();
  await finished(out);
  console.log(`kept ${keptIds.size} nodes`);
  return keptIds;
}

async function filterEdges(srcPath: string, destPath: string, keptIds: Set<string>) {
  const out = createWriteStream(destPath);
  const rl = createInterface({ input: createReadStream(srcPath) });
  let header: string[] | null = null;
  let srcIdx = -1;
  let dstIdx = -1;
  let count = 0;
  for await (const line of rl) {
    const cols = line.split(",");
    if (!header) {
      header = cols;
      srcIdx = header.indexOf("x_index");
      dstIdx = header.indexOf("y_index");
      out.write(line + "\n");
      continue;
    }
    if (keptIds.has(cols[srcIdx]!) && keptIds.has(cols[dstIdx]!)) {
      out.write(line + "\n");
      count++;
    }
  }
  out.end();
  await finished(out);
  console.log(`kept ${count} edges`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });

  const rawNodes = path.join(RAW_DIR, "nodes.csv");
  const rawEdges = path.join(RAW_DIR, "edges.csv");
  await download(NODES_URL, rawNodes);
  await download(EDGES_URL, rawEdges);

  const outNodes = path.join(OUT_DIR, "nodes.csv");
  const outEdges = path.join(OUT_DIR, "edges.csv");
  const keptIds = await filterNodes(rawNodes, outNodes);
  await filterEdges(rawEdges, outEdges, keptIds);

  console.log(`done. filtered CSVs in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

> **NOTE:** The PrimeKG file download IDs (`6180617`, `6180616`) are placeholders — verify against the current PrimeKG Harvard Dataverse page (`https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/IXA7BM`) and update before running. Same for column header names (`node_type`, `node_index`, `x_index`, `y_index`) — adjust to match the actual schema. This is a one-time ETL; spending a few minutes confirming the schema is faster than debugging a silent miss.

- [ ] **Step 3: Commit**

```bash
git add scripts/build-primekg-subset.ts package.json pnpm-lock.yaml
git commit -m "chore: PrimeKG subset builder script"
```

### Task 41b: PrimeKG Cypher loader

**Files:**
- Create: `scripts/load-primekg-to-neo4j.cypher`

- [ ] **Step 1: Write loader Cypher**

`scripts/load-primekg-to-neo4j.cypher`:
```cypher
// Constraints + indexes
CREATE CONSTRAINT node_id_unique IF NOT EXISTS FOR (n:Node) REQUIRE n.id IS UNIQUE;
CREATE INDEX node_type IF NOT EXISTS FOR (n:Node) ON (n.type);
CREATE INDEX node_name IF NOT EXISTS FOR (n:Node) ON (n.name);

// Nodes — adjust column names if PrimeKG schema differs
:auto LOAD CSV WITH HEADERS FROM 'file:///data/kg/nodes.csv' AS row
CALL {
  WITH row
  MERGE (n:Node {id: row.node_index})
  SET n.type = row.node_type,
      n.name = row.node_name,
      n.source = row.node_source
} IN TRANSACTIONS OF 5000 ROWS;

// Edges — relationship type set per row from display_relation
:auto LOAD CSV WITH HEADERS FROM 'file:///data/kg/edges.csv' AS row
CALL {
  WITH row
  MATCH (a:Node {id: row.x_index})
  MATCH (b:Node {id: row.y_index})
  CALL apoc.create.relationship(a, row.display_relation, {relation: row.relation}, b)
  YIELD rel
  RETURN rel
} IN TRANSACTIONS OF 5000 ROWS;
```

> **NOTE:** `apoc.create.relationship` requires the APOC plugin. Neo4j Desktop ships APOC as a one-click install per database. If APOC is unavailable, replace the `CALL apoc.create.relationship` block with a small set of `MERGE` clauses, one per known relation type (e.g., `drug_drug`, `drug_protein`, `disease_protein`, `protein_protein`, `bioprocess_protein`). PrimeKG has ~30 relation types in the subset; enumerate the ones you need.
>
> `file:///data/kg/nodes.csv` resolves relative to the Neo4j import directory by default. Either (a) configure Neo4j to allow `file://` URLs outside its import dir (set `dbms.security.allow_csv_import_from_file_urls=true` and use absolute paths), or (b) copy `data/kg/*.csv` into the Neo4j `import/` folder before running.

- [ ] **Step 2: Commit**

```bash
git add scripts/load-primekg-to-neo4j.cypher
git commit -m "chore: PrimeKG Cypher loader script"
```

---

## Phase 6: Verification

### Task 42: Repo-wide typecheck

- [ ] **Step 1: Typecheck all workspaces**

Run: `pnpm typecheck`
Expected: all three workspaces report no type errors.

- [ ] **Step 2: If errors, fix them inline. Do not skip.**

### Task 42a: Install and start local Neo4j

- [ ] **Step 1: Install [Neo4j Desktop](https://neo4j.com/download/)** (or `docker run` an instance). Create a new local DBMS. Pick a password and save it.

- [ ] **Step 2: Start the DBMS.** Browser UI should be reachable at `http://localhost:7474` and bolt at `bolt://localhost:7687`.

- [ ] **Step 3: (Optional, deferred) Install APOC plugin via the Plugins tab** if you'll be running the loader Cypher in this session. Not required for the skeleton verification.

> Skeleton scope: we verify *connectivity* to Neo4j, not that PrimeKG is loaded. Running the full ETL (`pnpm kg:build-subset && pnpm kg:load`) is documented but deferred — you can do it once you start implementing nodes that need data.

### Task 43: Verify `pnpm dev` boots both servers

- [ ] **Step 1: Ensure env files exist**

```bash
test -f apps/agent/.env || cp apps/agent/.env.example apps/agent/.env
test -f apps/web/.env.local || cp apps/web/.env.example apps/web/.env.local
```

OPENROUTER_API_KEY must be set in `apps/agent/.env`. NEO4J_PASSWORD must match the local DBMS password from Task 42a.

- [ ] **Step 2: Start both servers**

Run: `pnpm dev`
Expected:
- `agent: Server listening on http://localhost:2024`
- `web:   ready - started server on http://localhost:3000`

- [ ] **Step 3: Hit both endpoints**

In another terminal:
```bash
curl -s http://localhost:2024/assistants | head
curl -s http://localhost:3000 -o /dev/null -w "%{http_code}\n"
```
Expected:
- LangGraph: JSON with `clinical_trial_matching` assistant.
- Next.js: `200`.

- [ ] **Step 4: Smoke-test the Neo4j connection from a Node REPL**

```bash
cd apps/agent
node --env-file=.env --input-type=module -e "
import { pingKG } from './src/tools/kg.ts';
console.log(await pingKG());
"
```

Expected output: `true`.

(Run from `apps/agent` so the relative import works; on some Node versions you may need `--loader ts-node/esm` or simply test via a written `.ts` file run with `tsx`. If this is awkward, write a small `apps/agent/scripts/ping-kg.ts` and run `pnpm tsx scripts/ping-kg.ts`.)

- [ ] **Step 5: Visit `http://localhost:3000` in a browser**

Expected: empty patient sidebar (since `listPatients()` returns `[]` as a stub) and "Select a patient from the sidebar to begin." in the main area. No console errors.

- [ ] **Step 6: Kill servers (Ctrl+C). No commit needed.**

### Task 44: Final commit if anything changed during verification

- [ ] **Step 1: Check status**

Run: `git status`

- [ ] **Step 2: If clean, skeleton is done. If not, fix and commit:**

```bash
git add <files>
git commit -m "fix: verification fixes"
```

---

## Done state

After this plan completes:
- `pnpm install && pnpm typecheck && pnpm dev` works.
- `apps/agent` boots via `langgraph dev`, exposes the `clinical_trial_matching` graph wired with stub nodes including the mechanism-augmented topology (identify-relevant-mechanisms, find-repurposing-candidates) and the trial-eval subgraph with its evidence-fetch cycle.
- `apps/web` renders the patient-centric UI with empty/stub data, including a mechanisms panel.
- All shared types and zod schemas (Patient, Mechanism, Repurposing, Citation, Trial, etc.) defined.
- A local Neo4j Desktop instance is running and `pingKG()` returns true. PrimeKG data load is documented but deferred.
- Repo ready for the next plan: implementing nodes one at a time, starting with `extract-patient-profile` and `identify-relevant-mechanisms` (the two tasks with the cleanest dependencies — patient FHIR loader and KG Cypher queries respectively).
