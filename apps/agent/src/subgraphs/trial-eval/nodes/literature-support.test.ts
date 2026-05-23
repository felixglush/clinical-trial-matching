import { afterEach, describe, expect, it, vi } from "vitest";

import { literatureSupport } from "./literature-support.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  Citation,
  Mechanism,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as pubmed from "../../../tools/pubmed.js";

afterEach(() => vi.restoreAllMocks());

function citation(pmid: string, title = `t${pmid}`): Citation {
  return { pmid, title, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
}

function mech(conditionName: string, pathway?: string): Mechanism {
  return {
    conditionId: "x",
    conditionName,
    mondoId: "MONDO:0005148",
    geneTargets: [],
    pathways: pathway ? [{ id: "p", name: pathway, type: "biological_process" }] : [],
    supportingPaths: [],
    rationale: "",
  };
}

function trial(interventions: string[]): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "x",
    conditions: [],
    interventions,
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
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
      conditions: [
        {
          code: "44054006",
          system: "snomed",
          display: "Type 2 diabetes",
          clinicalStatus: "active",
        },
      ],
      medications: [],
      labs: [],
      priorTreatments: [],
    },
    candidate: trial(["metformin"]),
    mechanisms: [mech("type 2 diabetes", "glucose metabolism")],
    repurposingCandidates: [],
    eligibility: null,
    mechanismScore: null,
    mechanismRationale: null,
    literatureSupport: [],
    evidenceAttempts: 0,
    matches: [],
    ...overrides,
  };
}

describe("literatureSupport", () => {
  it("attempt 0 query includes drug AND condition AND mechanism keyword", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    await literatureSupport(state());
    expect(spy).toHaveBeenCalledTimes(1);
    const query = spy.mock.calls[0]![0];
    expect(query).toContain("metformin");
    expect(query).toContain("type 2 diabetes");
    expect(query).toContain("glucose metabolism");
  });

  it("attempt 1 (broaden) drops the mechanism keyword", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    await literatureSupport(state({ evidenceAttempts: 1 }));
    const query = spy.mock.calls[0]![0];
    expect(query).toContain("metformin");
    expect(query).toContain("type 2 diabetes");
    expect(query).not.toContain("glucose metabolism");
  });

  it("merges new citations with prior attempt (dedupe by pmid)", async () => {
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([
      citation("A"),
      citation("B"),
      citation("C"),
    ]);
    const out = await literatureSupport(
      state({
        evidenceAttempts: 1,
        literatureSupport: [citation("A"), citation("Z")],
      }),
    );
    const pmids = out.literatureSupport!.map((c) => c.pmid).sort();
    expect(pmids).toEqual(["A", "B", "C", "Z"]);
  });

  it("increments evidenceAttempts on success", async () => {
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([citation("A")]);
    const out = await literatureSupport(state({ evidenceAttempts: 0 }));
    expect(out.evidenceAttempts).toBe(1);
  });

  it("leaves literatureSupport unchanged but bumps attempts on PubMed failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(pubmed, "searchPubMed").mockRejectedValue(new Error("pubmed down"));
    const prior = [citation("A")];
    const out = await literatureSupport(
      state({ evidenceAttempts: 0, literatureSupport: prior }),
    );
    expect(out.literatureSupport).toEqual(prior);
    expect(out.evidenceAttempts).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("caps interventions to 3 in the query", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    await literatureSupport(
      state({ candidate: trial(["drugA", "drugB", "drugC", "drugD", "drugE"]) }),
    );
    const q = spy.mock.calls[0]![0];
    expect(q).toContain("drugA");
    expect(q).toContain("drugC");
    expect(q).not.toContain("drugD");
    expect(q).not.toContain("drugE");
  });
});
