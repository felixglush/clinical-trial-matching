import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { structuredInvoke, withStructuredOutput } = vi.hoisted(() => {
  const structuredInvoke = vi.fn();
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  return { structuredInvoke, withStructuredOutput };
});
vi.mock("../llm.js", () => ({
  llm: { withStructuredOutput },
}));

import { generateSearchStrategy } from "./generate-search-strategy.js";
import type { AgentStateType } from "../state.js";
import type { PatientProfile } from "@clinical-trial-matching/shared";

beforeEach(() => {
  structuredInvoke.mockReset();
  withStructuredOutput.mockClear();
});

afterEach(() => vi.restoreAllMocks());

function profile(overrides: Partial<PatientProfile> = {}): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 60,
    sex: "female",
    deceased: false,
    conditions: [
      {
        code: "44054006",
        system: "http://snomed.info/sct",
        display: "Type 2 diabetes mellitus",
        clinicalStatus: "active",
      },
    ],
    medications: [],
    labs: [],
    priorTreatments: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    patientProfile: profile(),
    mechanisms: [
      {
        conditionId: "44054006",
        conditionName: "Type 2 diabetes mellitus",
        mondoId: "MONDO:0005148",
        geneTargets: [{ id: "SLC5A2", name: "SLC5A2", type: "gene_protein" }],
        pathways: [{ id: "GO:0035623", name: "glucose reabsorption", type: "biological_process" }],
        supportingPaths: [],
        rationale: "primary driver",
      },
    ],
    searchStrategy: null,
    attempts: 0,
    ...overrides,
  } as unknown as AgentStateType;
}

describe("generateSearchStrategy", () => {
  it("produces a SearchStrategy on first attempt with attempt=1", async () => {
    structuredInvoke.mockResolvedValue({
      queries: ["type 2 diabetes SGLT2", "T2DM glucose reabsorption"],
      filters: { status: ["RECRUITING"] },
      broadeningApplied: [],
    });
    const out = await generateSearchStrategy(makeState());
    expect(out.searchStrategy?.queries).toEqual([
      "type 2 diabetes SGLT2",
      "T2DM glucose reabsorption",
    ]);
    expect(out.searchStrategy?.attempt).toBe(1);
    expect(out.searchStrategy?.broadeningApplied).toEqual([]);
    expect(out.attempts).toBe(1);
  });

  it("increments attempt count when a previous strategy exists", async () => {
    structuredInvoke.mockResolvedValue({
      queries: ["diabetes"],
      filters: {},
      broadeningApplied: ["dropped phase filter", "generalized SGLT2 → SGLT inhibitor"],
    });
    const out = await generateSearchStrategy(
      makeState({
        searchStrategy: {
          queries: ["type 2 diabetes SGLT2 phase 2"],
          filters: { phase: ["PHASE2"], status: ["RECRUITING"] },
          attempt: 1,
          broadeningApplied: [],
        },
        attempts: 1,
      }),
    );
    expect(out.searchStrategy?.attempt).toBe(2);
    expect(out.searchStrategy?.broadeningApplied).toContain("dropped phase filter");
    expect(out.attempts).toBe(2);
  });

  it("returns {error} when state.patientProfile is null", async () => {
    const out = await generateSearchStrategy(
      makeState({ patientProfile: null }),
    );
    expect(out.error).toMatch(/patient profile/i);
    expect(out.searchStrategy).toBeUndefined();
  });

  it("returns {error} when the LLM throws", async () => {
    structuredInvoke.mockRejectedValue(new Error("rate limited"));
    const out = await generateSearchStrategy(makeState());
    expect(out.error).toMatch(/Failed to generate search strategy.*rate limited/);
  });
});
