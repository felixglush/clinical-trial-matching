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
import { EMPTY_UNCLEAR_ELIGIBILITY, type TrialEvalStateType } from "../state.js";
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
    eligibility: EMPTY_UNCLEAR_ELIGIBILITY,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    counterEvidence: [],
    structuredCounterEvidence: {
      primeKgContraindications: [],
      txGnnPredContraindication: null,
      terminatedPriorTrials: [],
    },
    mechanismEvidence: [],
    counterEvidenceAddressed: null,
    matches: [],
    ...overrides,
  };
}

describe("mechanismPlausibility — TxGNN context integration (repurposing channel)", () => {
  it("passes TxGNN provenance (drug, predIndication, originalIndications, supporting path) into the prompt", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 88, rationale: "TxGNN + KG agree.", evidence: [] });
    await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(__invoke).toHaveBeenCalledTimes(1);
    const prompt = __invoke.mock.calls[0]![0] as string;
    // Provenance block names the channel.
    expect(prompt).toMatch(/Discovery channel/i);
    expect(prompt).toMatch(/repurposing/i);
    // TxGNN provenance: drug, score, original indication, explanation path.
    expect(prompt).toContain("osimertinib");
    expect(prompt).toContain("DB09330");
    expect(prompt).toContain("0.92");
    expect(prompt).toContain("nsclc");
    expect(prompt).toContain("EGFR");
    // The LLM's score (not predIndication × 100) is used.
  });

  it("uses the LLM's score, not predIndication × 100", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({
      score: 73,
      rationale: "TxGNN suggests; literature partially supports.",
      evidence: [{ pmid: "P1", quote: "q", supports: "weak" }],
    });
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(out.mechanismScore).toBe(73);
    expect(out.mechanismRationale).toContain("literature");
    expect(out.mechanismEvidence).toEqual([{ pmid: "P1", quote: "q", supports: "weak" }]);
  });

  it("prompt notes (none available) for TxGNN explanation path when supportingPaths is empty", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 50, rationale: "weak", evidence: [] });
    await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.85, false)],
      }),
    );
    const prompt = __invoke.mock.calls[0]![0] as string;
    expect(prompt).toMatch(/TxGNN explanation path:\s*\(none available\)/);
  });

  it("picks the highest predIndication when multiple repurposingDrugIds match", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 70, rationale: "ok", evidence: [] });
    await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330", "DB00072"]),
        repurposingCandidates: [
          repurposing("DB09330", 0.92, true),
          { ...repurposing("DB00072", 0.99, true), drug: { id: "DB00072", name: "trastuzumab", type: "drug" } },
        ],
      }),
    );
    const prompt = __invoke.mock.calls[0]![0] as string;
    // Highest predIndication (0.99 → trastuzumab) wins the TxGNN context slot.
    expect(prompt).toContain("trastuzumab");
    expect(prompt).toContain("0.99");
  });

  it("on LLM failure with TxGNN context: falls back to TxGNN templated score+rationale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    expect(out.mechanismScore).toBe(92); // round(0.92 * 100)
    expect(out.mechanismRationale).toContain("osimertinib");
    expect(out.mechanismRationale).toContain("LLM judge unavailable");
    expect(out.mechanismEvidence).toEqual([]);
    expect(out.counterEvidenceAddressed).toBeNull();
    warn.mockRestore();
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
    // Mechanism whitelist must be passed so noise edges (parent-child,
    // contraindication, ...) never reach the LLM as "mechanism evidence".
    const relTypes = pathSpy.mock.calls[0]![2] as readonly string[];
    expect(relTypes).toContain("target");
    expect(relTypes).toContain("ppi");
    expect(relTypes).toContain("associated with");
    expect(relTypes).not.toContain("parent-child");
    expect(relTypes).not.toContain("contraindication");
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

describe("mechanismPlausibility — dual-channel candidates", () => {
  it("for discoveredVia=['strategy','repurposing'], the prompt advertises both channels and includes TxGNN context", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 85, rationale: "both signals agree", evidence: [] });
    await mechanismPlausibility(
      state({
        candidate: trial(["strategy", "repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
      }),
    );
    const prompt = __invoke.mock.calls[0]![0] as string;
    expect(prompt).toMatch(/strategy/);
    expect(prompt).toMatch(/repurposing/);
    expect(prompt).toContain("osimertinib");
    expect(prompt).toContain("0.92");
  });

  // Invariant: search-trials only tags a candidate "repurposing" when its
  // drugId is in state.repurposingCandidates. If that's violated (a future
  // filter drops the supporting RepurposingCandidate but leaves the channel
  // marker), the LLM still runs but the prompt notes the missing TxGNN
  // context honestly rather than fabricating it.
  it("when discoveredVia=['repurposing'] but no matching RepurposingCandidate, judges on KG+lit alone and prompt notes the missing TxGNN record", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 55, rationale: "no TxGNN", evidence: [] });
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [], // invariant violated
      }),
    );
    expect(__invoke).toHaveBeenCalledTimes(1);
    const prompt = __invoke.mock.calls[0]![0] as string;
    expect(prompt).toMatch(/no matching TxGNN/i);
    expect(out.mechanismScore).toBe(55);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("for strategy-only candidates, the prompt explicitly states no TxGNN prediction is associated", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 60, rationale: "ok", evidence: [] });
    await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    const prompt = __invoke.mock.calls[0]![0] as string;
    expect(prompt).toMatch(/Strategy channel/i);
    expect(prompt).toMatch(/no TxGNN repurposing prediction/i);
  });

  it("on LLM failure with no TxGNN context: returns null score", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBeNull();
    expect(out.mechanismRationale).toBeNull();
    warn.mockRestore();
  });
});

describe("mechanismPlausibility — Path B literature integration (v1.5)", () => {
  it("passes literatureSupport and counterEvidence into mechanismScorePrompt", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({
      score: 70,
      rationale: "tier-1 supports",
      evidence: [{ pmid: "A1", quote: "supports", supports: "yes" }],
    });
    const out = await mechanismPlausibility(
      state({
        literatureSupport: [
          {
            pmid: "A1",
            title: "t",
            url: "u",
            pubtype: ["Randomized Controlled Trial"],
            abstractExcerpt: "abs",
          },
        ],
        structuredCounterEvidence: {
          primeKgContraindications: [],
          txGnnPredContraindication: null,
          terminatedPriorTrials: [],
        },
      }),
    );
    expect(out.mechanismScore).toBe(70);
    expect(out.mechanismRationale).toBe("tier-1 supports");
    expect(out.mechanismEvidence).toEqual([
      { pmid: "A1", quote: "supports", supports: "yes" },
    ]);
  });

  it("writes counterEvidenceAddressed when LLM provides it", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({
      score: 40,
      rationale: "weak overall",
      evidence: [{ pmid: "X1", quote: "futility", supports: "no" }],
      counterEvidenceAddressed: "Different population than this patient.",
    });
    const out = await mechanismPlausibility(
      state({
        structuredCounterEvidence: {
          primeKgContraindications: [],
          txGnnPredContraindication: null,
          terminatedPriorTrials: [
            {
              nctId: "NCT123",
              briefTitle: "Prior trial",
              conditions: [],
              interventions: [],
              status: "TERMINATED",
              whyStopped: "Lack of efficacy.",
            },
          ],
        },
      }),
    );
    expect(out.counterEvidenceAddressed).toBe(
      "Different population than this patient.",
    );
  });

  it("repurposing-channel candidates also get mechanismEvidence from the unified judge when literature is available", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB09330",
      name: "osimertinib",
      type: "drug",
    });
    __invoke.mockResolvedValue({
      score: 90,
      rationale: "TxGNN + literature converge",
      evidence: [{ pmid: "X", quote: "supports the mechanism", supports: "yes" }],
    });
    const out = await mechanismPlausibility(
      state({
        candidate: trial(["repurposing"], ["DB09330"]),
        repurposingCandidates: [repurposing("DB09330", 0.92, true)],
        literatureSupport: [
          { pmid: "X", title: "t", url: "u", pubtype: ["Randomized Controlled Trial"], abstractExcerpt: "abs" },
        ],
      }),
    );
    expect(out.mechanismScore).toBe(90);
    expect(out.mechanismEvidence).toEqual([
      { pmid: "X", quote: "supports the mechanism", supports: "yes" },
    ]);
  });
});

// Bedrock's tool-schema validator rejects `minimum`/`maximum` on integer
// types, so we removed those Zod constraints to keep the OpenRouter →
// Bedrock route working. The 0-100 bound is now enforced post-LLM via a
// clamp in the node.
describe("mechanismPlausibility — Path B score clamping", () => {
  it("clamps an out-of-range high score to 100", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 105, rationale: "off-by-five", evidence: [] });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBe(100);
  });

  it("clamps a negative score to 0", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: -5, rationale: "underflow", evidence: [] });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBe(0);
  });

  // The schema is `z.number()` (no `.int()`) because zod 4's `.int()` injects
  // safe-integer min/max into the JSON Schema, which Bedrock rejects. So the
  // node must round floats to integer before clamping.
  it("rounds a non-integer score to the nearest integer", async () => {
    vi.spyOn(kg, "pathBetween").mockResolvedValue([]);
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB",
      name: "drug",
      type: "drug",
    });
    __invoke.mockResolvedValue({ score: 75.6, rationale: "float", evidence: [] });
    const out = await mechanismPlausibility(state({ candidate: trial(["strategy"]) }));
    expect(out.mechanismScore).toBe(76);
  });
});
