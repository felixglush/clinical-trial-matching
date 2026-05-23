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
  return { pmid, title, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, pubtype: [] };
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
    counterEvidence: [],
    mechanismEvidence: [],
    counterEvidenceAddressed: null,
    matches: [],
    ...overrides,
  };
}

describe("literatureSupport", () => {
  it("attempt 0 query includes drug AND condition AND mechanism keyword", async () => {
    const spy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    await literatureSupport(state());
    // Attempt 0 issues a supporting query (call 0) and a counter-evidence
    // query (call 1). The supporting query is asserted here.
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

describe("literatureSupport — abstracts + pubtype", () => {
  it("calls fetchAbstracts for the supporting-query results and merges into citations", async () => {
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([
      { pmid: "A", title: "tA", url: "u", pubtype: ["Review"] },
      { pmid: "B", title: "tB", url: "u", pubtype: [] },
    ]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(
      new Map([["A", "Abstract for A."]]),
    );
    const out = await literatureSupport(state());
    const a = out.literatureSupport!.find((c) => c.pmid === "A")!;
    const b = out.literatureSupport!.find((c) => c.pmid === "B")!;
    expect(a.abstractExcerpt).toBe("Abstract for A.");
    expect(b.abstractExcerpt).toBeUndefined();
  });

  it("soft-fails when fetchAbstracts throws (citations keep abstractExcerpt undefined)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([
      { pmid: "A", title: "tA", url: "u", pubtype: [] },
    ]);
    vi.spyOn(pubmed, "fetchAbstracts").mockRejectedValue(new Error("EFetch down"));
    const out = await literatureSupport(state());
    expect(out.literatureSupport![0]!.abstractExcerpt).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("literatureSupport — counter-evidence", () => {
  it("issues a second PubMed query with counter-evidence terms ANDed", async () => {
    const searchSpy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    await literatureSupport(state());
    expect(searchSpy).toHaveBeenCalledTimes(2);
    const counterQuery = searchSpy.mock.calls[1]![0];
    expect(counterQuery).toMatch(/metformin/);
    expect(counterQuery).toMatch(/type 2 diabetes/);
    expect(counterQuery).toMatch(/failed|discontinued|futility|toxicity|negative|withdrawn|no benefit/);
  });

  it("writes counter-evidence to state.counterEvidence (separate from literatureSupport)", async () => {
    const supportingHits = [{ pmid: "S1", title: "supporting", url: "u", pubtype: [] }];
    const counterHits = [{ pmid: "C1", title: "failed trial", url: "u", pubtype: [] }];
    vi.spyOn(pubmed, "searchPubMed").mockImplementation(async (q) =>
      /failed|discontinued|futility|toxicity|negative|withdrawn|no benefit/.test(q)
        ? counterHits
        : supportingHits,
    );
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    const out = await literatureSupport(state());
    expect(out.literatureSupport!.map((c) => c.pmid)).toEqual(["S1"]);
    expect(out.counterEvidence!.map((c) => c.pmid)).toEqual(["C1"]);
  });

  it("does NOT run a second counter-evidence query on attempt 1 (broaden only applies to supporting)", async () => {
    const searchSpy = vi.spyOn(pubmed, "searchPubMed").mockResolvedValue([]);
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    await literatureSupport(state({ evidenceAttempts: 1 }));
    expect(searchSpy).toHaveBeenCalledTimes(1);  // supporting only on broaden
  });

  it("soft-fails when counter-evidence query throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(pubmed, "searchPubMed").mockImplementation(async (q) =>
      /failed|discontinued/.test(q)
        ? Promise.reject(new Error("PubMed down"))
        : [],
    );
    vi.spyOn(pubmed, "fetchAbstracts").mockResolvedValue(new Map());
    const out = await literatureSupport(state());
    expect(out.counterEvidence).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
