import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../llm.js", () => {
  const invoke = vi.fn();
  return {
    llm: {
      withStructuredOutput: () => ({ invoke }),
    },
    __invoke: invoke,
  };
});

import { mechanismPlausibility } from "./mechanism-plausibility.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  Mechanism,
  RepurposingCandidate,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as kg from "../../../tools/kg.js";
// @ts-expect-error — vi.mock pseudo-export
import { __invoke } from "../../../llm.js";

afterEach(() => {
  vi.restoreAllMocks();
  __invoke.mockReset();
});

function mech(): Mechanism {
  return {
    conditionId: "254637007",
    conditionName: "non-small cell lung carcinoma",
    mondoId: "MONDO:0005233",
    geneTargets: [{ id: "EGFR", name: "EGFR", type: "gene_protein" }],
    pathways: [{ id: "GO:0038127", name: "ERBB signaling pathway", type: "biological_process" }],
    supportingPaths: [],
    rationale: "",
  };
}

function trial(discoveredVia: ("strategy" | "repurposing")[], repurposingDrugIds: string[] = []): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Osimertinib in NSCLC",
    conditions: ["Non-small cell lung carcinoma"],
    interventions: ["Osimertinib"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: discoveredVia as [typeof discoveredVia[0], ...typeof discoveredVia],
    repurposingDrugIds,
    stdAges: [],
  };
}

function repurposing(drugId: string, predIndication: number, withPath: boolean): RepurposingCandidate {
  return {
    drug: { id: drugId, name: "osimertinib", type: "drug" },
    originalIndications: ["nsclc"],
    rationale: "",
    supportingPaths: withPath
      ? [
          {
            nodes: [
              { id: drugId, name: "osimertinib", type: "drug" },
              { id: "EGFR", name: "EGFR", type: "gene_protein" },
              { id: "MONDO:0005233", name: "nsclc", type: "disease" },
            ],
            edges: [
              { source: drugId, target: "EGFR", relation: "target" },
              { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
            ],
          },
        ]
      : [],
    predIndication,
    predContraindication: 0.05,
  };
}

function state(overrides: Partial<TrialEvalStateType> = {}): TrialEvalStateType {
  return {
    patientProfile: {
      id: "p1",
      displayName: "x",
      ageYears: 60,
      sex: "female",
      deceased: false,
      conditions: [],
      medications: [],
      labs: [],
      priorTreatments: [],
    },
    candidate: trial(["strategy"]),
    mechanisms: [mech()],
    repurposingCandidates: [],
    eligibility: null,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    match: null,
    ...overrides,
  };
}

describe("mechanismPlausibility — Path A (repurposing channel, LLM-free)", () => {
  it("uses TxGNN predIndication × 100 as the score; templated rationale with path summary; LLM never called", async () => {
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(out.mechanismScore).toBe(92);
    // Templated rationale references drug name + score + intermediate node names from supportingPaths.
    expect(out.mechanismRationale).toContain("osimertinib");
    expect(out.mechanismRationale).toContain("0.92");
    expect(out.mechanismRationale).toContain("EGFR");
    // CRITICAL: no LLM call in Path A.
    expect(__invoke).not.toHaveBeenCalled();
  });

  it("templates 'no TxGNN explanation path available' when supportingPaths is empty", async () => {
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.85, false)],
      }),
    );
    expect(out.mechanismScore).toBe(85);
    expect(out.mechanismRationale).toMatch(/no TxGNN explanation path available/i);
    expect(__invoke).not.toHaveBeenCalled();
  });

  it("picks the highest predIndication when multiple repurposingDrugIds match", async () => {
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330", "DB00072"]),
        repurposingCandidates: [
          repurposing("DB09330", 0.92, true),
          { ...repurposing("DB00072", 0.99, true), drug: { id: "DB00072", name: "trastuzumab", type: "drug" } },
        ],
      }),
    );
    expect(out.mechanismScore).toBe(99);
    expect(out.mechanismRationale).toContain("trastuzumab");
    expect(__invoke).not.toHaveBeenCalled();
  });
});

describe("mechanismPlausibility — Path B (strategy channel)", () => {
  it("calls kg.pathBetween per (intervention, mechanism) pair and LLM scores", async () => {
    const pathSpy = vi.spyOn(kg, "pathBetween").mockResolvedValue([
      {
        nodes: [{ id: "DB", name: "drug", type: "drug" }],
        edges: [],
      },
    ]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 75, rationale: "Direct path." });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(pathSpy).toHaveBeenCalled();
    expect(out.mechanismScore).toBe(75);
    expect(out.mechanismRationale).toBe("Direct path.");
  });

  it("returns null score + null rationale on LLM failure (Path B)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBeNull();
    expect(out.mechanismRationale).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still runs the LLM step with empty paths if pathBetween returns nothing", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 25, rationale: "No path." });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBe(25);
  });
});

describe("mechanismPlausibility — both channels", () => {
  it("Path A takes precedence when discoveredVia includes 'repurposing'; LLM never called", async () => {
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["strategy", "repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(out.mechanismScore).toBe(92);
    expect(out.mechanismRationale).toContain("osimertinib");
    expect(__invoke).not.toHaveBeenCalled();
  });
});
