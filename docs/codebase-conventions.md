# Codebase conventions

How we organize and write code in this repo. Project rules that affect
*tooling* (pinned versions, etc.) live in [`CLAUDE.md`](../CLAUDE.md);
this doc covers *code* — file layout, naming, DRY/KISS calls, testing
patterns, and how to extend the system without rotting it.

Treat anything here as a default that can be argued against in a PR.
Don't argue against it silently.

## Package boundaries

- **`packages/shared`** — pure schemas (zod), inferred types, helpers
  that act on those types (e.g. `isActiveCondition`), and any
  agent↔web contract (e.g. `GraphStateSchema`). No I/O. No Node-only
  APIs. Must compile under both bundler and Node module resolutions.
- **`apps/agent`** — LangGraph nodes, KG tools, prompts, FHIR
  extraction, anything that runs on the LangGraph runtime. Imports from
  `shared`; never imports from `web`.
- **`apps/web`** — Next.js app. Imports from `shared`; never imports
  from `agent` source (the agent runs out-of-process).

If you're tempted to copy a type from agent to web, the type belongs in
`shared`.

## Naming

- Files: kebab-case. Modules with a single responsibility take the
  singular: `patient-loader.ts`, `mechanism.ts`. Avoid `-utils` —
  prefer a domain-named module.
- Test files sit next to their source: `foo.ts` ↔ `foo.test.ts`.
- E2E tests live in `apps/web/tests/e2e/*.spec.ts` (separate dir because
  they drive the running app and aren't tied to a source file).
- Constants: `SCREAMING_SNAKE`. Type-only aliases: `PascalCase`.

## DRY rules (the only ones we enforce)

The bar isn't "no repetition." It's "no repetition that can drift."
Three concrete tripwires we've already hit:

1. **Sets / configs about a domain concept.** "Which `clinicalStatus`
   values count as active?" exists exactly once
   (`shared/patient.ts::ACTIVE_CONDITION_STATUSES` +
   `isActiveCondition`). Same rule for enums + their labels (see
   `MECHANISM_DROP_REASONS`).
2. **The agent state shape.** Canonical in
   `shared/state.ts::GraphStateSchema`. The agent's `AgentStateType`
   has a compile-time `_Equal` assertion against `GraphState` — they
   diverge → typecheck fails. Web pulls from `GraphState` via `Pick`
   rather than redefining.
3. **Anything where a number is mentioned twice in the same flow.**
   `MECHANISM_PICKS_CAP` is one constant; the prompt text
   interpolates it. "up to 5" hardcoded next to a cap of 10 is a
   silent bug we will hit.

If you find yourself adding the same set, label, number, or shape in
two places, stop. Extract first.

## KISS rules

- **No dead stubs.** Throwing `"not implemented"` placeholders rot. They
  signal "this exists" to future readers and tempt copy-paste. Delete
  until you're implementing the consumer in the same change.
- **No premature abstraction.** Three call sites is the bar for
  extracting a helper. Two is "consider it." One is "leave it inline."
- **No defensive programming for things that can't happen.** Validate
  at boundaries (zod schemas at parse points, env at startup). Trust
  internal callers.
- **No backwards-compat shims** for code that hasn't shipped. Rename
  freely; we have typecheck.

## Test conventions

- **Unit tests** (`*.test.ts`) co-located with source. Use Vitest. Run
  with `pnpm -r test`.
- **E2E tests** (`*.spec.ts`) in `apps/web/tests/e2e/`. Use Playwright.
  Run with `pnpm --filter web test:e2e`. Drives the live agent + Neo4j +
  LLM; treat as integration coverage, not gating CI.

Mocking pattern in vitest:

- **`vi.mock(path, factory)`** — when the module has top-level side
  effects (e.g. `llm.ts` throws on missing env at import). Combine with
  `vi.hoisted()` so shared mock instances can be referenced inside the
  factory. Example: `apps/agent/src/nodes/identify-relevant-mechanisms.test.ts`.
- **`vi.spyOn(module, "fn")`** — when the module imports cleanly and
  you only want to swap one export. Example:
  `apps/agent/src/tools/kg.test.ts` swapping
  `buildCandidateMechanisms`.

E2E test data must come from `shared/patient-fixtures.ts` — never
hardcode a slug list.

## Error handling

- Throw inside helpers; catch at node boundaries.
- The standard "stringify an unknown error" helper is
  `apps/agent/src/util/error.ts::errorMessage`. Use it instead of
  inlining `err instanceof Error ? err.message : String(err)`.
- Node return shape: success → `{ ...partialState }`. Failure →
  `{ error: "Failed to <thing>: <reason>" }`. The verb in the message
  matches what failed ("Failed to query KG", "Failed to rank
  mechanisms").

## Extending the system

Three common extension recipes — follow these, don't invent your own:

### Adding a field to agent state

1. Add the zod schema field in `shared/state.ts::GraphStateSchema`.
2. Add a matching `Annotation<>` to `apps/agent/src/state.ts`. The
   compile-time `_Equal<AgentStateType, GraphState>` check catches drift.
3. If the field should reach the web UI, no further wiring needed — the
   SSE stream already forwards everything in `values`. Web components
   destructure what they care about from `GraphState`.

### Adding a new node

1. Create `apps/agent/src/nodes/<name>.ts` with a `<name>(state):
   Promise<Partial<AgentStateType>>` export.
2. Co-locate `<name>.test.ts`.
3. Wire into the graph in `apps/agent/src/graph.ts`.
4. If it consumes the LLM and needs unit tests, mock `../llm.js` with
   `vi.mock` (see pattern above).
5. Update `docs/topology.md` if the workflow shape changes.

### Adding a new `MechanismDrop` reason

1. Append an entry to `MECHANISM_DROP_REASONS` in
   `shared/mechanism.ts`. Pick a stable `value` and a friendly `label`.
2. Add the production logic in `identify-relevant-mechanisms.ts`.
3. Add a unit test asserting the reason fires under the right
   condition.
4. UIs update automatically (they iterate the config).

### Adding a new patient archetype

1. Append a fixture to `shared/patient-fixtures.ts`.
2. Add the Synthea bundle to `data/synthea-output/fhir/`.
3. Playwright e2e suite picks it up automatically (it iterates fixtures).

## Things we deliberately don't do

- **No Redux/Zustand on the web.** SSE → `useState` is enough.
- **No GraphQL.** REST + LangGraph SDK covers it.
- **No DI framework.** Test seams via exported setters (e.g.
  `kg.ts::setDriver`) are sufficient at this scale.
- **No barrel re-exports beyond `shared/index.ts`.** Keep import paths
  honest.
