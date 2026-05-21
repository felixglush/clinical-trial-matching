/**
 * End-to-end smoke test for the mechanism-feed layer.
 *
 * Runs both downstream-of-`identify-relevant-mechanisms` nodes
 * (`find-repurposing-candidates` and `generate-search-strategy`) against
 * the committed TxGNN starter dataset and a representative archetype
 * patient. Proves the code runs end-to-end and produces populated outputs
 * for `state.repurposingCandidates` and `state.searchStrategy`.
 *
 * The LLM is mocked (no live API call). The TxGNN data loader uses the
 * REAL committed JSON files at apps/agent/src/data/txgnn-*.json — no
 * fixture injection — so this also exercises the dynamic-import + load
 * caching path that unit tests bypass via `__setFixturesForTests`.
 *
 * If this test fails, the user-facing goal "the code runs end to end
 * finding repurposing candidates and generating a search strategy" is
 * broken; pin down which node's contract regressed before claiming green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { structuredInvoke, withStructuredOutput } = vi.hoisted(() => {
  const structuredInvoke = vi.fn();
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  return { structuredInvoke, withStructuredOutput };
});
vi.mock("../llm.js", () => ({
  llm: { withStructuredOutput },
}));

import { findRepurposingCandidates } from "../nodes/find-repurposing-candidates.js";
import { generateSearchStrategy } from "../nodes/generate-search-strategy.js";
import type { AgentStateType } from "../state.js";
import type { Mechanism, PatientProfile } from "@clinical-trial-matching/shared";

beforeEach(() => {
  structuredInvoke.mockReset();
  withStructuredOutput.mockClear();
});

afterEach(() => vi.restoreAllMocks());

// Archetype patient — type 2 diabetic with chronic kidney disease.
// Both MONDO ids exist in the curated TxGNN dataset, and they overlap
// (dapagliflozin and empagliflozin are predicted for both), which
// exercises the cross-disease dedup logic in find-repurposing-candidates.
function archetypeT2DMWithCKD(): { profile: PatientProfile; mechanisms: Mechanism[] } {
  const profile: PatientProfile = {
    id: "smoke-t2dm-ckd",
    displayName: "Archetype T2DM+CKD",
    ageYears: 62,
    sex: "female",
    deceased: false,
    conditions: [
      {
        code: "44054006",
        system: "http://snomed.info/sct",
        display: "Type 2 diabetes mellitus",
        clinicalStatus: "active",
      },
      {
        code: "709044004",
        system: "http://snomed.info/sct",
        display: "Chronic kidney disease",
        clinicalStatus: "active",
      },
    ],
    medications: [
      {
        code: "DB00331",
        system: "drugbank",
        display: "metformin",
        events: [{ date: "2024-01-01", status: "active" }],
      },
    ],
    labs: [],
    priorTreatments: [],
  };
  const mechanisms: Mechanism[] = [
    {
      conditionId: "44054006",
      conditionName: "Type 2 diabetes mellitus",
      mondoId: "MONDO:0005148",
      geneTargets: [{ id: "SLC5A2", name: "SLC5A2", type: "gene_protein" }],
      pathways: [{ id: "GO:0035623", name: "glucose reabsorption", type: "biological_process" }],
      supportingPaths: [],
      rationale: "primary metabolic driver",
    },
    {
      conditionId: "709044004",
      conditionName: "Chronic kidney disease",
      mondoId: "MONDO:0005300",
      geneTargets: [],
      pathways: [],
      supportingPaths: [],
      rationale: "comorbidity influencing drug selection",
    },
  ];
  return { profile, mechanisms };
}

function stateFor(input: { profile: PatientProfile; mechanisms: Mechanism[] }): AgentStateType {
  return {
    patientProfile: input.profile,
    mechanisms: input.mechanisms,
    searchStrategy: null,
    attempts: 0,
  } as unknown as AgentStateType;
}

describe("feed-layer end-to-end (real TxGNN data + mocked LLM)", () => {
  it("find-repurposing-candidates produces candidates from the committed starter dataset", async () => {
    const state = stateFor(archetypeT2DMWithCKD());
    const out = await findRepurposingCandidates(state);

    expect(out.error).toBeUndefined();
    const candidates = out.repurposingCandidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);

    // Metformin should surface as a top candidate for T2DM (predIndication 0.94
    // in the curated starter set).
    const metformin = candidates.find((c) => c.drug.id === "DB00331");
    expect(metformin).toBeDefined();
    expect(metformin!.predIndication).toBeCloseTo(0.94, 5);
    expect(metformin!.rationale).toContain("TxGNN");

    // Dapagliflozin is predicted for both T2DM and CKD. The dedup logic
    // should keep it once with both diseases in originalIndications.
    const dapa = candidates.find((c) => c.drug.id === "DB06292");
    expect(dapa).toBeDefined();
    expect(dapa!.originalIndications).toEqual(
      expect.arrayContaining([
        "Type 2 diabetes mellitus",
        "Chronic kidney disease",
      ]),
    );

    // Sanity: a known explanation path should attach to dapagliflozin.
    expect(dapa!.supportingPaths.length).toBeGreaterThan(0);
    expect(dapa!.supportingPaths[0]!.nodes.map((n) => n.name)).toContain("SLC5A2");
  });

  it("generate-search-strategy produces a SearchStrategy with the LLM mock", async () => {
    structuredInvoke.mockResolvedValue({
      queries: ["type 2 diabetes SGLT2", "chronic kidney disease SGLT2"],
      filters: { status: ["RECRUITING"] },
      broadeningApplied: [],
    });

    const state = stateFor(archetypeT2DMWithCKD());
    const out = await generateSearchStrategy(state);

    expect(out.error).toBeUndefined();
    expect(out.searchStrategy).toBeDefined();
    expect(out.searchStrategy?.queries).toEqual([
      "type 2 diabetes SGLT2",
      "chronic kidney disease SGLT2",
    ]);
    expect(out.searchStrategy?.attempt).toBe(1);
    expect(out.attempts).toBe(1);

    // The prompt-construction step must have happened (it's what feeds
    // the structured output). Confirm by checking the LLM was called.
    expect(structuredInvoke).toHaveBeenCalledOnce();
    const prompt = structuredInvoke.mock.calls[0]![0];
    expect(prompt).toContain("Type 2 diabetes mellitus");
    expect(prompt).toContain("Chronic kidney disease");
    expect(prompt).toContain("age: 62, sex: female");
    // Active medication should surface; should NOT show treatment-naive.
    expect(prompt).toContain("- metformin");
    expect(prompt).not.toContain("(none — treatment-naive)");
  });

  it("both nodes can run on the same state and produce a coherent feed for search-trials", async () => {
    structuredInvoke.mockResolvedValue({
      queries: ["T2DM SGLT2 CKD"],
      filters: { status: ["RECRUITING"] },
      broadeningApplied: [],
    });

    const state = stateFor(archetypeT2DMWithCKD());

    // Run both nodes in parallel (mirrors graph.ts wiring).
    const [repurpOut, strategyOut] = await Promise.all([
      findRepurposingCandidates(state),
      generateSearchStrategy(state),
    ]);

    // Neither errored.
    expect(repurpOut.error).toBeUndefined();
    expect(strategyOut.error).toBeUndefined();

    // Both produced populated outputs ready for search-trials to consume.
    expect((repurpOut.repurposingCandidates ?? []).length).toBeGreaterThan(0);
    expect(strategyOut.searchStrategy?.queries.length).toBeGreaterThan(0);

    // Sanity: drug names from candidates are the kind of strings search-trials
    // will use as CT.gov intervention queries.
    const drugNames = (repurpOut.repurposingCandidates ?? []).map((c) => c.drug.name);
    expect(drugNames).toEqual(expect.arrayContaining(["metformin"]));
  });
});
