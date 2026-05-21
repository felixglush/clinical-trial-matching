/**
 * # identify-relevant-mechanisms
 *
 * Bridges the patient-side `PatientProfile` (FHIR/SNOMED-coded) to the
 * biomedical knowledge graph (PrimeKG/MONDO-coded) and produces a ranked,
 * rationale-bearing list of disease mechanisms to drive downstream
 * trial-matching and drug-repurposing nodes.
 *
 * Design and rationale lives in `docs/superpowers/specs/2026-05-20-
 * identify-relevant-mechanisms-design.md`. Keep this docstring + the spec
 * in sync when the node's shape changes.
 *
 * ## Pipeline
 *
 * ```text
 *   state.patientProfile
 *       │
 *       │  activeConditionsAsInputs()  — keep conditions with
 *       │    clinicalStatus ∈ {active, recurrence, relapse} ∪ {undefined}
 *       ▼
 *   ConditionInput[]
 *       │
 *       │  buildCandidateMechanisms()  — kg.ts (Promise.all per condition)
 *       │    ├─► resolveSnomedCondition()  ← snomed-to-primekg.json
 *       │    │     (unresolved SNOMED codes → returned in `unresolved[]`,
 *       │    │      logged but non-fatal)
 *       │    ├─► findGeneTargetsForDisease()  — Cypher (disease)-[:`associated
 *       │    │     with`]-(g:gene/protein); type-normalized to gene_protein
 *       │    └─► findPathwaysForDisease()     — 2-hop traversal
 *       │           (disease)-[:`associated with`]-(g)-[:`interacts with`]-(p:bp)
 *       │           ranked by count(DISTINCT g), top-15
 *       │       supportingPaths constructed client-side from sharedGeneIds
 *       ▼
 *   CandidateMechanism[]   (Mechanism without `rationale`)
 *       │
 *       │  mechanismPrompt(profile, candidates)  — compact:
 *       │     top 8 gene names + top 8 pathway names per condition
 *       │  ──► llm.withStructuredOutput(MechanismPicksSchema)
 *       │     {picks: [{conditionId, rationale}, ...]}
 *       ▼
 *   picks.slice(0, MECHANISM_PICKS_CAP)
 *       │
 *       │  orderedMechanismsFromPicks()
 *       │     - look up candidate by conditionId
 *       │     - dedup by conditionId (first pick wins)
 *       │     - drop picks whose conditionId is not in the candidate set
 *       ▼
 *   state.mechanisms : Mechanism[]   (ordered by LLM-assigned priority)
 * ```
 *
 * ## Why a crosswalk (not a name match)
 *
 * PrimeKG diseases are MONDO-only; their `node_source` is `MONDO` or
 * `MONDO_grouped`. There is no SNOMED column to join on. The two options
 * were: fuzzy match `condition.display` against PrimeKG `node_name`, or
 * use MONDO's published SNOMED↔MONDO mappings (SSSOM) to build a SNOMED
 * → PrimeKG-node-id table offline. We took SSSOM because:
 *
 *   - PrimeKG is granular ("breast carcinoma", "female breast carcinoma",
 *     "breast adenocarcinoma", ...) — substring matching on "breast"
 *     fires on dozens of unrelated nodes, and exact display matching
 *     misses synonyms.
 *   - SSSOM gives an authoritative SNOMED-keyed lookup; offline build keeps
 *     the runtime path I/O-free (`tools/snomed-mondo.ts` is a pure
 *     in-memory dict over the committed JSON).
 *
 * Build the crosswalk with `pnpm kg:build-crosswalk`. Output:
 * `apps/agent/src/data/snomed-to-primekg.json`. Drops `broadMatch` /
 * `narrowMatch` predicates (too lossy for clinical use); prefers
 * `exactMatch` over `closeMatch` on collisions.
 *
 * ## Active-condition filter
 *
 * Conditions pass the filter when `clinicalStatus` is one of
 * {`active`, `recurrence`, `relapse`} or is absent (lenient — see
 * extract-patient-profile's missing-status convention). Resolved /
 * inactive / remission states are dropped because mechanism work on
 * historical comorbidities just generates noise for the LLM and consumes
 * Neo4j roundtrips. The exact set is also baked into `mechanismPrompt`
 * so the prompt's "active conditions" block stays in sync.
 *
 * ## Two Cypher queries, no third
 *
 * Per resolved condition we issue exactly two queries — gene targets
 * (`g.id`, `g.name`) and pathways (`p.id`, `p.name`, `sharedGeneIds[]`).
 * `supportingPaths` (disease → gene → pathway sample triples) are
 * synthesized in TypeScript from the `sharedGeneIds` already returned by
 * the pathway query: for each top pathway, pick up to 2 of its shared
 * genes and emit one `KGPath` each. This keeps the round-trip count
 * predictable and lets us cap the supporting evidence shape independently
 * of how many genes a disease has (cancers often have hundreds).
 *
 * Why undirected matching (`-[:assoc]-` not `-[:assoc]->`): PrimeKG's
 * relationships are inherently symmetric in meaning but were imported
 * with arbitrary direction. APOC's `create.relationship` picks one
 * orientation per row; queries must not depend on it. `DISTINCT` is
 * required on the gene query because the undirected match traverses each
 * edge twice.
 *
 * Why `pathwayLimit` uses `neo4j.int(...)`: the driver maps raw JS
 * numbers to Cypher FLOAT; `LIMIT` rejects FLOAT.
 *
 * ## Type normalization at the boundary
 *
 * PrimeKG stores the gene/protein node type as the literal string
 * `gene/protein` (with a slash) because the original CSV does. The shared
 * `KGNode.type` enum uses the identifier-safe form `gene_protein`. The
 * Cypher queries match the literal form (otherwise zero rows return —
 * which is exactly how we caught this on the live KG); `kg.ts` rewrites
 * to the schema form when materializing `KGNode`. Don't propagate the
 * raw form outside `kg.ts`.
 *
 * ## LLM step: rank, filter, narrate
 *
 * Why an LLM at all (rather than ranking pathways by shared-gene count
 * client-side): the per-condition pathway query already produces a
 * shared-protein-ranked list. But that ranking is *within* one disease's
 * neighborhood. Choosing across multiple diseases for a single patient
 * — "which mechanism matters most for *this* patient's trial search?" —
 * benefits from clinical context the KG doesn't carry (e.g. oncology
 * primary drivers vs background comorbidities, treatment history,
 * drug-interaction-aware repurposing intent). The LLM call is bounded
 * (≤5 picks, compact prompt) so latency and cost stay tame.
 *
 * `MechanismPicksSchema` deliberately omits `.max(MAX_PICKS)` on the
 * picks array. Anthropic models on OpenRouter route through Amazon
 * Bedrock for many regions, and Bedrock's structured-output validator
 * rejects JSON Schema `maxItems` with a 400. The cap is therefore
 * enforced (a) in the prompt instructions ("Return up to 5 picks") and
 * (b) by `picks.slice(0, MECHANISM_PICKS_CAP)` in the node. Don't
 * reintroduce `.max(...)` on this schema without re-testing against
 * the Bedrock route.
 *
 * ## Dedup defensiveness
 *
 * The prompt instructs the model to use each `conditionId` at most once.
 * Empirically the model occasionally violates this when there is one
 * candidate (it emits the same conditionId several times with different
 * angles). `orderedMechanismsFromPicks` therefore dedupes by
 * `conditionId`, keeping the first pick (highest LLM-assigned priority).
 * Unknown conditionIds (LLM hallucinating an id not in the candidate
 * set) are warned and dropped — we never return a Mechanism that doesn't
 * correspond to an actual patient condition.
 *
 * ## Error model
 *
 * Failure modes and their handling — chosen so this node never silently
 * degrades downstream nodes:
 *
 *   - `state.patientProfile == null`        → return {error}, no work.
 *   - 0 active conditions after filter      → return {mechanisms: []}.
 *     Not an error. Downstream search /
 *     repurposing handle empty input.
 *   - Some SNOMED codes unresolvable        → process the resolvable
 *     ones; log the misses. The patient still gets mechanisms.
 *   - All SNOMED codes unresolvable         → return {mechanisms: []};
 *     not an error (log already emitted).
 *   - Neo4j unreachable / Cypher throws     → return {error: "Failed to
 *     query KG: ..."}.
 *   - LLM API failure / structured-output
 *     validation failure                    → return {error: "Failed to
 *     rank mechanisms: ..."}.
 *   - LLM picks an unknown conditionId      → skip + warn, no error.
 *
 * No in-node retries — graph-level retry policies (if any) handle
 * transients. Retrying expensive KG + LLM work inside a single node call
 * compounds latency in ways the broader workflow can't observe.
 */

import {
  isActiveCondition,
  type Mechanism,
  type MechanismDrop,
  type PatientProfile,
} from "@clinical-trial-matching/shared";

import {
  buildCandidateMechanisms,
  type CandidateMechanism,
} from "../tools/kg.js";
import {
  MECHANISM_PICKS_CAP,
  MechanismPicksSchema,
  mechanismPrompt,
} from "../prompts/mechanism.js";
import { llm } from "../llm.js";
import type { AgentStateType } from "../state.js";
import { errorMessage } from "../util/error.js";

export async function identifyRelevantMechanisms(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const profile = state.patientProfile;
  if (!profile) {
    return { error: "No patient profile available" };
  }

  const { active, inactiveDrops } = partitionActiveConditions(profile);
  if (active.length === 0) {
    return { mechanisms: [], mechanismDrops: inactiveDrops };
  }

  let candidates: CandidateMechanism[];
  let unresolved: string[];
  try {
    ({ candidates, unresolved } = await buildCandidateMechanisms(
      active.map((c) => ({ snomedCode: c.code, conditionDisplay: c.display })),
    ));
  } catch (err) {
    return { error: `Failed to query KG: ${errorMessage(err)}` };
  }

  const unresolvedDrops = makeUnresolvedDrops(active, unresolved);
  if (unresolved.length > 0) {
    console.warn(
      `identify-relevant-mechanisms: ${unresolved.length} SNOMED code(s) unresolved against PrimeKG crosswalk: ${unresolved.join(", ")}`,
    );
  }

  if (candidates.length === 0) {
    return {
      mechanisms: [],
      mechanismDrops: [...inactiveDrops, ...unresolvedDrops],
    };
  }

  let picks;
  try {
    const structured = llm.withStructuredOutput(MechanismPicksSchema);
    const prompt = mechanismPrompt(profile, candidates);
    picks = (await structured.invoke(prompt)).picks;
  } catch (err) {
    return { error: `Failed to rank mechanisms: ${errorMessage(err)}` };
  }

  const cappedPicks = picks.slice(0, MECHANISM_PICKS_CAP);
  const mechanisms = orderedMechanismsFromPicks(cappedPicks, candidates);
  const notPickedDrops = makeNotPickedDrops(candidates, mechanisms);

  return {
    mechanisms,
    mechanismDrops: [...inactiveDrops, ...unresolvedDrops, ...notPickedDrops],
  };
}

function partitionActiveConditions(profile: PatientProfile): {
  active: PatientProfile["conditions"];
  inactiveDrops: MechanismDrop[];
} {
  const active: PatientProfile["conditions"] = [];
  const inactiveDrops: MechanismDrop[] = [];
  for (const c of profile.conditions) {
    if (isActiveCondition(c)) {
      active.push(c);
    } else {
      inactiveDrops.push({
        code: c.code,
        display: c.display,
        reason: "inactive",
        detail: `clinicalStatus=${c.clinicalStatus}`,
      });
    }
  }
  return { active, inactiveDrops };
}

function makeUnresolvedDrops(
  active: PatientProfile["conditions"],
  unresolvedCodes: string[],
): MechanismDrop[] {
  const unresolvedSet = new Set(unresolvedCodes);
  return active
    .filter((c) => unresolvedSet.has(c.code))
    .map((c) => ({
      code: c.code,
      display: c.display,
      reason: "unresolved" as const,
      detail: "no MONDO entry in SNOMED→PrimeKG crosswalk",
    }));
}

function makeNotPickedDrops(
  candidates: CandidateMechanism[],
  mechanisms: Mechanism[],
): MechanismDrop[] {
  const picked = new Set(mechanisms.map((m) => m.conditionId));
  return candidates
    .filter((c) => !picked.has(c.conditionId))
    .map((c) => ({
      code: c.conditionId,
      display: c.conditionName,
      reason: "not-picked" as const,
      detail: `LLM ranked below top ${MECHANISM_PICKS_CAP}`,
    }));
}

function orderedMechanismsFromPicks(
  picks: ReadonlyArray<{ conditionId: string; rationale: string }>,
  candidates: CandidateMechanism[],
): Mechanism[] {
  const byId = new Map(candidates.map((c) => [c.conditionId, c]));
  // Dedup defensively: the prompt says "each conditionId at most once" but if
  // the LLM ignores that we keep the first (most-relevant) pick per condition.
  const seen = new Set<string>();
  const out: Mechanism[] = [];
  for (const p of picks) {
    const cand = byId.get(p.conditionId);
    if (!cand) {
      console.warn(
        `identify-relevant-mechanisms: LLM picked unknown conditionId '${p.conditionId}', skipping`,
      );
      continue;
    }
    if (seen.has(p.conditionId)) continue;
    seen.add(p.conditionId);
    out.push({ ...cand, rationale: p.rationale });
  }
  return out;
}
