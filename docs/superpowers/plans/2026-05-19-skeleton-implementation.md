# Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the project skeleton (pnpm workspace monorepo, three packages, configs, stub files) so node implementations can be added incrementally.

**Architecture:** pnpm workspace monorepo. `apps/agent` (LangGraph.js workflow → LangGraph Platform), `apps/web` (Next.js → Vercel), `packages/shared` (zod schemas + types). Node bodies are stubs; the goal is `pnpm install && pnpm dev` boots both servers and `pnpm typecheck` passes.

**Tech Stack:** TypeScript 5.6.3, pnpm 9, Node 20, Next.js 15.0.3, LangGraph.js (`@langchain/langgraph` 0.2.36), LangGraph SDK (`@langchain/langgraph-sdk` 0.0.32), `@langchain/anthropic` 0.3.7, zod 3.23.8, Tailwind 3.4.14, shadcn/ui.

**Conventions:**
- All package.json dependency versions are exact (no `^`/`~`). See [CLAUDE.md](../../../CLAUDE.md).
- Every node file is a stub that compiles and returns a placeholder partial state; no real logic in this plan.
- No test framework setup — there is nothing meaningful to test until nodes have logic. Verification is `pnpm typecheck` and "the dev servers boot."

---

## File Structure

Files this plan creates, grouped by phase:

**Phase 1 — Root scaffolding:**
- `.npmrc`, `.nvmrc`, `.gitignore`, `.editorconfig`, `tsconfig.base.json`, `pnpm-workspace.yaml`, `package.json`, `README.md`

**Phase 2 — `packages/shared/`:**
- `package.json`, `tsconfig.json`
- `src/{patient,search,trial,eligibility,run,state,index}.ts`

**Phase 3 — `apps/agent/`:**
- `package.json`, `tsconfig.json`, `langgraph.json`, `.env.example`
- `src/{llm,state,graph}.ts`
- `src/nodes/{extract-patient-profile,generate-search-strategy,search-trials,pre-filter,route-after-pre-filter,rank-and-synthesize,human-approval}.ts`
- `src/subgraphs/trial-eval/{state,graph}.ts`
- `src/tools/{clinicaltrials,patient-loader}.ts`
- `src/prompts/{extract-profile,search-strategy,pre-filter,trial-eval,rank}.ts`

**Phase 4 — `apps/web/`:**
- `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `components.json`, `.env.example`
- `src/app/{layout,page,globals.css}.tsx|css`
- `src/app/patients/[patientId]/{layout,page}.tsx`
- `src/app/patients/[patientId]/runs/[threadId]/page.tsx`
- `src/app/patients/[patientId]/chat/page.tsx`
- `src/app/api/patients/route.ts`, `src/app/api/patients/[patientId]/route.ts`
- `src/app/api/patients/[patientId]/runs/route.ts`
- `src/app/api/runs/[threadId]/{stream,state,history,resume}/route.ts`
- `src/components/{patient-sidebar,patient-header,match-history-list}.tsx`
- `src/components/run-view/{index,graph-timeline,reasoning-trace,candidates-panel,approval-panel}.tsx`
- `src/components/chat/placeholder.tsx`
- `src/components/ui/button.tsx` (one shadcn primitive to verify wiring)
- `src/lib/{langgraph,patients-loader,types}.ts`

**Phase 5 — Data + scripts:**
- `data/patients/{patient-1,patient-2,patient-3}.json`
- `scripts/generate-patients.sh`, `scripts/README.md`

**Phase 6 — Verification & docs:**
- Verify everything boots, update root `README.md`.

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
.env
.env.local
.env.*.local
*.log
.DS_Store
.vscode/
.idea/
```

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
  "packageManager": "pnpm@9.12.3",
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
    "typescript": "5.6.3",
    "prettier": "3.3.3"
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

Prerequisites: Node 20, pnpm 9, an `ANTHROPIC_API_KEY`.

```bash
pnpm install
cp apps/agent/.env.example apps/agent/.env
cp apps/web/.env.example apps/web/.env.local
# fill in ANTHROPIC_API_KEY in apps/agent/.env
pnpm dev
```

- Agent (LangGraph dev server + Studio): http://localhost:2024
- Web (Next.js): http://localhost:3000

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
    "zod": "3.23.8"
  },
  "devDependencies": {
    "typescript": "5.6.3"
  }
}
```

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
  concerns: z.array(z.string()),
});
export type TrialMatch = z.infer<typeof TrialMatchSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/trial.ts
git commit -m "feat(shared): TrialCandidate and TrialMatch schemas"
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
import { SearchStrategySchema } from "./search.js";
import { TrialCandidateSchema, TrialMatchSchema } from "./trial.js";
import { ApprovalRequestSchema } from "./run.js";

export const GraphStateSchema = z.object({
  patientId: z.string(),
  patientProfile: PatientProfileSchema.nullable(),
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
    "@langchain/anthropic": "0.3.7",
    "@langchain/core": "0.3.18",
    "@langchain/langgraph": "0.2.36",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "@langchain/langgraph-cli": "0.0.21",
    "typescript": "5.6.3"
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
ANTHROPIC_API_KEY=
LANGSMITH_API_KEY=
LANGSMITH_TRACING=true
LANGSMITH_PROJECT=clinical-trial-matching
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
import { ChatAnthropic } from "@langchain/anthropic";

export const llm = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  temperature: 0,
  maxRetries: 2,
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/llm.ts
git commit -m "feat(agent): configure shared LLM client"
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

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/tools/clinicaltrials.ts apps/agent/src/tools/patient-loader.ts
git commit -m "feat(agent): tool stubs (clinicaltrials, patient-loader)"
```

### Task 18: Prompt stubs

**Files:**
- Create: `apps/agent/src/prompts/extract-profile.ts`
- Create: `apps/agent/src/prompts/search-strategy.ts`
- Create: `apps/agent/src/prompts/pre-filter.ts`
- Create: `apps/agent/src/prompts/trial-eval.ts`
- Create: `apps/agent/src/prompts/rank.ts`

- [ ] **Step 1: Write each prompt stub**

`apps/agent/src/prompts/extract-profile.ts`:
```ts
export function extractProfilePrompt(_fhirBundle: unknown): string {
  // TODO: implement prompt that extracts PatientProfile from FHIR bundle
  return "";
}
```

`apps/agent/src/prompts/search-strategy.ts`:
```ts
import type { PatientProfile, SearchStrategy } from "@clinical-trial-matching/shared";

export function searchStrategyPrompt(
  _profile: PatientProfile,
  _previousAttempt: SearchStrategy | null,
): string {
  // TODO: implement prompt that produces SearchStrategy; broadens if previousAttempt set
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

`apps/agent/src/prompts/trial-eval.ts`:
```ts
import type { PatientProfile, TrialCandidate } from "@clinical-trial-matching/shared";

export function trialEvalPrompt(_profile: PatientProfile, _candidate: TrialCandidate): string {
  // TODO: implement detailed per-criterion eligibility eval prompt
  return "";
}
```

`apps/agent/src/prompts/rank.ts`:
```ts
import type { PatientProfile, TrialMatch } from "@clinical-trial-matching/shared";

export function rankPrompt(_profile: PatientProfile, _matches: TrialMatch[]): string {
  // TODO: implement final ranking + synthesis prompt
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
  // TODO: call clinicaltrials.searchTrials(state.searchStrategy); store in candidates.
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

### Task 23: Subgraph — `trial-eval`

**Files:**
- Create: `apps/agent/src/subgraphs/trial-eval/state.ts`
- Create: `apps/agent/src/subgraphs/trial-eval/graph.ts`

- [ ] **Step 1: Write subgraph state**

`apps/agent/src/subgraphs/trial-eval/state.ts`:
```ts
import { Annotation } from "@langchain/langgraph";
import type {
  PatientProfile,
  TrialCandidate,
  TrialMatch,
} from "@clinical-trial-matching/shared";

export const TrialEvalState = Annotation.Root({
  patientProfile: Annotation<PatientProfile>,
  candidate: Annotation<TrialCandidate>,
  match: Annotation<TrialMatch | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type TrialEvalStateType = typeof TrialEvalState.State;
```

- [ ] **Step 2: Write subgraph**

`apps/agent/src/subgraphs/trial-eval/graph.ts`:
```ts
import { StateGraph, START, END } from "@langchain/langgraph";
import { TrialEvalState, type TrialEvalStateType } from "./state.js";

async function evaluate(_state: TrialEvalStateType): Promise<Partial<TrialEvalStateType>> {
  // TODO: call LLM with trialEvalPrompt; produce TrialMatch.
  return { match: null };
}

export const trialEvalGraph = new StateGraph(TrialEvalState)
  .addNode("evaluate", evaluate)
  .addEdge(START, "evaluate")
  .addEdge("evaluate", END)
  .compile();
```

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/subgraphs/trial-eval/state.ts apps/agent/src/subgraphs/trial-eval/graph.ts
git commit -m "feat(agent): trial-eval subgraph stub"
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
  return state.candidates.map(
    (candidate) =>
      new Send("trial-eval-subgraph", {
        patientProfile: profile,
        candidate,
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
import { generateSearchStrategy } from "./nodes/generate-search-strategy.js";
import { searchTrials } from "./nodes/search-trials.js";
import { preFilter } from "./nodes/pre-filter.js";
import { routeAfterPreFilter } from "./nodes/route-after-pre-filter.js";
import { rankAndSynthesize } from "./nodes/rank-and-synthesize.js";
import { humanApproval } from "./nodes/human-approval.js";
import { trialEvalGraph } from "./subgraphs/trial-eval/graph.js";

export const graph = new StateGraph(AgentState)
  .addNode("extract-patient-profile", extractPatientProfile)
  .addNode("generate-search-strategy", generateSearchStrategy)
  .addNode("search-trials", searchTrials)
  .addNode("pre-filter", preFilter)
  .addNode("trial-eval-subgraph", trialEvalGraph)
  .addNode("rank-and-synthesize", rankAndSynthesize)
  .addNode("human-approval", humanApproval)
  .addEdge(START, "extract-patient-profile")
  .addEdge("extract-patient-profile", "generate-search-strategy")
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

> Routing note: `routeAfterPreFilter` returns either the string `"generate-search-strategy"` (broaden-and-retry loop) or `Send[]` targeting `"trial-eval-subgraph"` (parallel fan-out). The third argument to `addConditionalEdges` is the list of *possible* downstream node names — used for graph visualization, not for runtime selection.

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

- [ ] **Step 1: Set ANTHROPIC_API_KEY in env**

```bash
cp apps/agent/.env.example apps/agent/.env
# manually edit apps/agent/.env and set ANTHROPIC_API_KEY=<your key>
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
    "@langchain/langgraph-sdk": "0.0.32",
    "next": "15.0.3",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "class-variance-authority": "0.7.0",
    "clsx": "2.1.1",
    "lucide-react": "0.453.0",
    "tailwind-merge": "2.5.4"
  },
  "devDependencies": {
    "@types/node": "20.16.13",
    "@types/react": "18.3.12",
    "@types/react-dom": "18.3.1",
    "autoprefixer": "10.4.20",
    "postcss": "8.4.47",
    "tailwindcss": "3.4.14",
    "typescript": "5.6.3",
    "eslint": "8.57.1",
    "eslint-config-next": "15.0.3"
  }
}
```

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

### Task 31: Tailwind + shadcn config

**Files:**
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/components.json`
- Create: `apps/web/src/app/globals.css`

- [ ] **Step 1: Write `tailwind.config.ts`**

`apps/web/tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};

export default config;
```

- [ ] **Step 2: Write `postcss.config.mjs`**

`apps/web/postcss.config.mjs`:
```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 3: Write `components.json`**

`apps/web/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
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

- [ ] **Step 4: Write `globals.css`**

`apps/web/src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/tailwind.config.ts apps/web/postcss.config.mjs apps/web/components.json apps/web/src/app/globals.css
git commit -m "chore(web): tailwind + shadcn config"
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
- Create: `apps/web/src/components/run-view/candidates-panel.tsx`
- Create: `apps/web/src/components/run-view/approval-panel.tsx`

- [ ] **Step 1: Write `graph-timeline.tsx`**

`apps/web/src/components/run-view/graph-timeline.tsx`:
```tsx
"use client";

const NODES = [
  "extract-patient-profile",
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

- [ ] **Step 3: Write `candidates-panel.tsx`**

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
  // TODO: render candidates / matches as they update.
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

- [ ] **Step 4: Write `approval-panel.tsx`**

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

- [ ] **Step 5: Write `run-view/index.tsx`**

`apps/web/src/components/run-view/index.tsx`:
```tsx
"use client";
import { GraphTimeline } from "./graph-timeline";
import { ReasoningTrace } from "./reasoning-trace";
import { CandidatesPanel } from "./candidates-panel";

export function RunView({ threadId: _threadId }: { threadId: string }) {
  // TODO: open SSE stream to /api/runs/[threadId]/stream;
  // dispatch updates/values/messages to child panels.
  return (
    <div className="grid grid-cols-[200px_1fr_1fr] gap-6">
      <GraphTimeline activeNode={null} />
      <ReasoningTrace messages={[]} />
      <CandidatesPanel candidates={[]} matches={[]} />
    </div>
  );
}
```

- [ ] **Step 6: Commit**

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
```markdown
# Scripts

## generate-patients.sh

Generates synthetic FHIR patient bundles via [Synthea](https://github.com/synthetichealth/synthea).

**Requires:** Java 11+

```bash
pnpm patients:generate          # 10 patients (default)
pnpm patients:generate -- 50    # 50 patients
```

Output lands in `data/patients/`. The script clones Synthea into `.synthea/` on first run (gitignored).
```

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-patients.sh scripts/README.md
git commit -m "chore: Synthea runner script"
```

---

## Phase 6: Verification

### Task 42: Repo-wide typecheck

- [ ] **Step 1: Typecheck all workspaces**

Run: `pnpm typecheck`
Expected: all three workspaces report no type errors.

- [ ] **Step 2: If errors, fix them inline. Do not skip.**

### Task 43: Verify `pnpm dev` boots both servers

- [ ] **Step 1: Ensure env files exist**

```bash
test -f apps/agent/.env || cp apps/agent/.env.example apps/agent/.env
test -f apps/web/.env.local || cp apps/web/.env.example apps/web/.env.local
```

ANTHROPIC_API_KEY must be set in `apps/agent/.env`.

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

- [ ] **Step 4: Visit `http://localhost:3000` in a browser**

Expected: empty patient sidebar (since `listPatients()` returns `[]` as a stub) and "Select a patient from the sidebar to begin." in the main area. No console errors.

- [ ] **Step 5: Kill servers (Ctrl+C). No commit needed.**

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
- `apps/agent` boots via `langgraph dev`, exposes the `clinical_trial_matching` graph wired with stub nodes.
- `apps/web` renders the patient-centric UI with empty/stub data.
- All shared types and zod schemas defined.
- Repo ready for the next plan: implementing nodes one at a time.
