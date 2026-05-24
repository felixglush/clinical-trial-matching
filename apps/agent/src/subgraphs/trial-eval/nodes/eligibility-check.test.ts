import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../llm.js", () => {
  const invoke = vi.fn();
  return {
    llm: {
      withStructuredOutput: () => ({ invoke }),
    },
    __invoke: invoke,
  };
});

import { eligibilityCheck } from "./eligibility-check.js";
import { EMPTY_UNCLEAR_ELIGIBILITY, type TrialEvalStateType } from "../state.js";
import type {
  PatientProfile,
  SafetyConcern,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as kg from "../../../tools/kg.js";
// @ts-expect-error — vi.mock pseudo-export
import { __invoke } from "../../../llm.js";

afterEach(() => {
  vi.restoreAllMocks();
  __invoke.mockReset();
});

function profile(): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 65,
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
  };
}

function trial(): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Trastuzumab"],
    status: "RECRUITING",
    locations: [],
    eligibilityCriteriaText: "Adults 18-75 with T2DM",
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
  };
}

function state(): TrialEvalStateType {
  return {
    patientProfile: profile(),
    candidate: trial(),
    mechanisms: [],
    repurposingCandidates: [],
    eligibility: EMPTY_UNCLEAR_ELIGIBILITY,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    counterEvidence: [],
    mechanismEvidence: [],
    counterEvidenceAddressed: null,
    matches: [],
  };
}

describe("eligibilityCheck", () => {
  it("runs the safety check and merges concerns into the assessment", async () => {
    const concern: SafetyConcern = {
      drugId: "DB00072",
      drugName: "trastuzumab",
      conditionId: "MONDO:0005010",
      conditionName: "heart failure",
      relation: "contraindication",
    };
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB00072",
      name: "trastuzumab",
      type: "drug",
    });
    vi.spyOn(kg, "findContraindicationsForDrugs").mockResolvedValue([concern]);
    __invoke.mockResolvedValue({
      inclusion: [{ criterion: "T2DM", met: "yes", evidence: "active condition" }],
      exclusion: [],
      overall: "likely_eligible",
    });
    const out = await eligibilityCheck(state());
    expect(out.eligibility!.safetyConcerns).toEqual([concern]);
    expect(out.eligibility!.overall).toBe("likely_eligible");
  });

  it("falls back to unclear on LLM failure but preserves safetyConcerns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue(null);
    vi.spyOn(kg, "findContraindicationsForDrugs").mockResolvedValue([]);
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await eligibilityCheck(state());
    expect(out.eligibility!.overall).toBe("unclear");
    expect(out.eligibility!.safetyConcerns).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("proceeds with empty safetyConcerns when the Cypher safety call throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(kg, "resolveDrugByName").mockResolvedValue({
      id: "DB00072",
      name: "trastuzumab",
      type: "drug",
    });
    vi.spyOn(kg, "findContraindicationsForDrugs").mockRejectedValue(new Error("neo4j down"));
    __invoke.mockResolvedValue({
      inclusion: [],
      exclusion: [],
      overall: "unclear",
    });
    const out = await eligibilityCheck(state());
    expect(out.eligibility!.safetyConcerns).toEqual([]);
    expect(out.eligibility!.overall).toBe("unclear");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips unresolvable interventions without erroring", async () => {
    const resolveSpy = vi.spyOn(kg, "resolveDrugByName").mockResolvedValue(null);
    const safetySpy = vi.spyOn(kg, "findContraindicationsForDrugs").mockResolvedValue([]);
    __invoke.mockResolvedValue({
      inclusion: [],
      exclusion: [],
      overall: "unclear",
    });
    await eligibilityCheck(state());
    expect(resolveSpy).toHaveBeenCalled();
    // No interventions resolved → safety call uses empty drugIds → still called or short-circuited;
    // either is acceptable, but the result must be [] either way.
    expect(safetySpy.mock.calls[0]?.[0] ?? []).toEqual([]);
  });
});
