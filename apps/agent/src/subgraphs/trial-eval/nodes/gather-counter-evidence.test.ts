import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../tools/kg.js", () => ({
  resolveDrugByName: vi.fn(),
  findContraindicationsForDrugs: vi.fn(),
}));
vi.mock("../../../tools/clinicaltrials.js", () => ({
  searchTerminatedPriorTrials: vi.fn(),
}));
vi.mock("../../../tools/snomed-mondo.js", () => ({
  resolveSnomedCondition: vi.fn(),
}));

import { gatherCounterEvidence } from "./gather-counter-evidence.js";
import * as kg from "../../../tools/kg.js";
import * as ctg from "../../../tools/clinicaltrials.js";
import * as crosswalk from "../../../tools/snomed-mondo.js";
import { EMPTY_UNCLEAR_ELIGIBILITY, type TrialEvalStateType } from "../state.js";

function baseState(overrides: Partial<TrialEvalStateType> = {}): TrialEvalStateType {
  return {
    patientProfile: {
      id: "p1",
      displayName: "Test Patient",
      ageYears: 60,
      sex: "female",
      deceased: false,
      conditions: [
        {
          code: "254637007",
          system: "snomed",
          display: "Non-small cell lung carcinoma",
          clinicalStatus: "active",
        },
      ],
      medications: [],
      priorTreatments: [],
      labs: [],
    },
    candidate: {
      nctId: "NCT99999999",
      title: "Trial",
      conditions: ["NSCLC"],
      interventions: ["Osimertinib"],
      status: "RECRUITING",
      locations: [],
      stdAges: [],
      discoveredVia: ["strategy"],
      repurposingDrugIds: [],
    } as unknown as TrialEvalStateType["candidate"],
    mechanisms: [
      {
        conditionId: "254637007",
        conditionName: "Non-small cell lung carcinoma",
        mondoId: "MONDO:0005233",
        geneTargets: [],
        pathways: [],
        supportingPaths: [],
        rationale: "",
      },
    ] as TrialEvalStateType["mechanisms"],
    repurposingCandidates: [],
    eligibility: EMPTY_UNCLEAR_ELIGIBILITY,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    structuredCounterEvidence: {
      primeKgContraindications: [],
      txGnnPredContraindication: null,
      terminatedPriorTrials: [],
    },
    mechanismEvidence: [],
    counterEvidenceAddressed: null,
    evidenceAttempts: 0,
    matches: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(kg.resolveDrugByName).mockReset();
  vi.mocked(kg.findContraindicationsForDrugs).mockReset();
  vi.mocked(ctg.searchTerminatedPriorTrials).mockReset();
  vi.mocked(crosswalk.resolveSnomedCondition).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("gatherCounterEvidence", () => {
  it("collects PrimeKG contraindications, terminated trials, and TxGNN predContraindication", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      mondoId: "MONDO:0005233", primekgNodeId: "MONDO:0005233", primekgName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([{
      drugId: "DB09330", drugName: "osimertinib",
      conditionId: "MONDO:0005233", conditionName: "NSCLC",
      relation: "contraindication",
    }]);
    vi.mocked(ctg.searchTerminatedPriorTrials).mockResolvedValue([{
      nctId: "NCT01234567", briefTitle: "Prior",
      conditions: ["NSCLC"], interventions: ["Osimertinib"],
      phase: "PHASE3", status: "TERMINATED",
      whyStopped: "Stopped for lack of efficacy.",
      completionDate: "2021-08-15",
    }]);

    const state = baseState({
      candidate: {
        ...baseState().candidate,
        discoveredVia: ["repurposing"],
        repurposingDrugIds: ["DB09330"],
      } as TrialEvalStateType["candidate"],
      repurposingCandidates: [{
        drug: { id: "DB09330", name: "osimertinib", type: "drug" },
        originalIndications: ["NSCLC"],
        predIndication: 0.9,
        predContraindication: 0.81,
        supportingPaths: [],
        rationale: "",
      }] as TrialEvalStateType["repurposingCandidates"],
    });

    const out = await gatherCounterEvidence(state);

    expect(out.structuredCounterEvidence).toEqual({
      primeKgContraindications: [{
        drugId: "DB09330", drugName: "osimertinib",
        conditionId: "MONDO:0005233", conditionName: "NSCLC",
        relation: "contraindication",
      }],
      txGnnPredContraindication: 0.81,
      terminatedPriorTrials: [{
        nctId: "NCT01234567", briefTitle: "Prior",
        conditions: ["NSCLC"], interventions: ["Osimertinib"],
        phase: "PHASE3", status: "TERMINATED",
        whyStopped: "Stopped for lack of efficacy.",
        completionDate: "2021-08-15",
      }],
    });
  });

  it("returns null txGnnPredContraindication when no matching RepurposingCandidate", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      mondoId: "MONDO:0005233", primekgNodeId: "MONDO:0005233", primekgName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);
    vi.mocked(ctg.searchTerminatedPriorTrials).mockResolvedValue([]);

    const out = await gatherCounterEvidence(baseState());
    expect(out.structuredCounterEvidence?.txGnnPredContraindication).toBeNull();
  });

  it("soft-fails when PrimeKG throws — leaves contraindications empty, continues with CT.gov", async () => {
    vi.mocked(kg.resolveDrugByName).mockRejectedValue(new Error("neo4j down"));
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      mondoId: "MONDO:0005233", primekgNodeId: "MONDO:0005233", primekgName: "NSCLC",
    });
    vi.mocked(ctg.searchTerminatedPriorTrials).mockResolvedValue([{
      nctId: "NCT01", briefTitle: "T", conditions: [], interventions: [],
      status: "TERMINATED",
    }]);

    const out = await gatherCounterEvidence(baseState());
    expect(out.structuredCounterEvidence?.primeKgContraindications).toEqual([]);
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toHaveLength(1);
  });

  it("soft-fails when CT.gov throws — leaves terminatedPriorTrials empty", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      mondoId: "MONDO:0005233", primekgNodeId: "MONDO:0005233", primekgName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);
    vi.mocked(ctg.searchTerminatedPriorTrials).mockRejectedValue(new Error("ctgov 503"));

    const out = await gatherCounterEvidence(baseState());
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toEqual([]);
  });

  it("skips CT.gov entirely when candidate has no interventions", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue(null);
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      mondoId: "MONDO:0005233", primekgNodeId: "MONDO:0005233", primekgName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);

    const state = baseState({
      candidate: { ...baseState().candidate, interventions: [] } as TrialEvalStateType["candidate"],
    });
    const out = await gatherCounterEvidence(state);
    expect(ctg.searchTerminatedPriorTrials).not.toHaveBeenCalled();
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toEqual([]);
  });

  it("dedupes terminated trials by nctId when multiple interventions return overlapping results", async () => {
    vi.mocked(kg.resolveDrugByName).mockResolvedValue({
      id: "DB09330", name: "osimertinib", type: "drug",
    });
    vi.mocked(crosswalk.resolveSnomedCondition).mockReturnValue({
      mondoId: "MONDO:0005233", primekgNodeId: "MONDO:0005233", primekgName: "NSCLC",
    });
    vi.mocked(kg.findContraindicationsForDrugs).mockResolvedValue([]);

    // Two interventions, both queries return the SAME trial.
    const sharedTrial = {
      nctId: "NCT00000001",
      briefTitle: "Same trial returned by both queries",
      conditions: ["NSCLC"],
      interventions: ["Osimertinib"],
      status: "TERMINATED" as const,
      whyStopped: "Lack of efficacy.",
    };
    vi.mocked(ctg.searchTerminatedPriorTrials)
      .mockResolvedValueOnce([sharedTrial])
      .mockResolvedValueOnce([sharedTrial]);

    const state = baseState({
      candidate: {
        ...baseState().candidate,
        interventions: ["DrugA", "DrugB"],
      } as TrialEvalStateType["candidate"],
    });

    const out = await gatherCounterEvidence(state);

    expect(ctg.searchTerminatedPriorTrials).toHaveBeenCalledTimes(2);
    expect(out.structuredCounterEvidence?.terminatedPriorTrials).toHaveLength(1);
    expect(out.structuredCounterEvidence?.terminatedPriorTrials?.[0]?.nctId).toBe("NCT00000001");
  });
});
