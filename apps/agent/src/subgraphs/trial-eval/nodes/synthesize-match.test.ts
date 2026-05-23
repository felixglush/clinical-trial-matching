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

import { synthesizeMatch } from "./synthesize-match.js";
import type { TrialEvalStateType } from "../state.js";
import type {
  Citation,
  EligibilityAssessment,
  RepurposingCandidate,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

// @ts-expect-error — vi.mock pseudo-export
import { __invoke } from "../../../llm.js";

afterEach(() => __invoke.mockReset());

function trial(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Drug X"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
    ...overrides,
  };
}

function elig(overall: EligibilityAssessment["overall"]): EligibilityAssessment {
  return { inclusion: [], exclusion: [], overall, safetyConcerns: [] };
}

function citation(pmid: string): Citation {
  return { pmid, title: `t${pmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, pubtype: [] };
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
    candidate: trial(),
    mechanisms: [],
    repurposingCandidates: [],
    eligibility: elig("likely_eligible"),
    mechanismScore: 80,
    mechanismRationale: "Drug X targets the relevant pathway.",
    literatureSupport: [citation("1"), citation("2"), citation("3")],
    evidenceAttempts: 1,
    counterEvidence: [],
    mechanismEvidence: [],
    counterEvidenceAddressed: null,
    matches: [],
    ...overrides,
  };
}

describe("synthesizeMatch — score formula (eligibility + mechanism only; no literature)", () => {
  it("eligible + mechanism 80 → 92", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({ eligibility: elig("eligible"), mechanismScore: 80 }),
    );
    // 0.6*100 + 0.4*80 = 60 + 32 = 92
    expect(out.matches![0]!.score).toBe(92);
  });

  it("likely_ineligible + null mechanism → capped at 25 by gate", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({
        eligibility: elig("likely_ineligible"),
        mechanismScore: null,
        mechanismRationale: null,
        literatureSupport: [],
      }),
    );
    // weightedSum = 0.6*25 + 0.4*50 = 15 + 20 = 35. Gate: min(25, 35) = 25.
    expect(out.matches![0]!.score).toBe(25);
  });

  it("ineligible + great biology → 0 (gate)", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: ["patient ineligible"] });
    const out = await synthesizeMatch(
      state({
        eligibility: elig("ineligible"),
        mechanismScore: 90,
        literatureSupport: [citation("a"), citation("b"), citation("c"), citation("d")],
      }),
    );
    expect(out.matches![0]!.score).toBe(0);
  });

  it("citation count does not affect the score (literature is not in the formula)", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out0 = await synthesizeMatch(state({ literatureSupport: [] }));
    const out10 = await synthesizeMatch(
      state({
        literatureSupport: Array.from({ length: 10 }, (_, i) => citation(String(i))),
      }),
    );
    expect(out0.matches![0]!.score).toBe(out10.matches![0]!.score);
  });

  it("null mechanism maps to 50 in the formula", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({ mechanismScore: null, mechanismRationale: null }),
    );
    // eligibility=likely_eligible(75) + mechanism=null→50
    // = 0.6*75 + 0.4*50 = 45 + 20 = 65
    expect(out.matches![0]!.score).toBe(65);
  });
});

describe("synthesizeMatch — repurposingRationale", () => {
  it("populates repurposingRationale for repurposing-channel candidates", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const rc: RepurposingCandidate = {
      drug: { id: "DB09330", name: "osimertinib", type: "drug" },
      originalIndications: ["non-small cell lung carcinoma"],
      rationale: "TxGNN",
      supportingPaths: [],
      predIndication: 0.92,
      predContraindication: 0.05,
    };
    const out = await synthesizeMatch(
      state({
        candidate: trial({ discoveredVia: ["repurposing"], repurposingDrugIds: ["DB09330"] }),
        repurposingCandidates: [rc],
      }),
    );
    expect(out.matches![0]!.repurposingRationale).not.toBeNull();
    expect(out.matches![0]!.repurposingRationale!.drugName).toBe("osimertinib");
    expect(out.matches![0]!.repurposingRationale!.originalIndications).toEqual([
      "non-small cell lung carcinoma",
    ]);
    expect(out.matches![0]!.repurposingRationale!.summary).toContain("0.92");
  });

  it("leaves repurposingRationale null for strategy-only candidates", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state());
    expect(out.matches![0]!.repurposingRationale).toBeNull();
  });
});

describe("synthesizeMatch — fallback on LLM failure", () => {
  it("computes deterministic score and assembles match even when narrate LLM fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockRejectedValue(new Error("LLM down"));
    const out = await synthesizeMatch(state());
    expect(out.matches).toHaveLength(1);
    expect(out.matches![0]!.score).toBeGreaterThan(0);
    expect(out.matches![0]!.summary).toContain("Drug X for T2DM");
    warn.mockRestore();
  });

  it("includes deterministic concerns when LLM falls back (e.g. ineligible)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockRejectedValue(new Error("x"));
    const out = await synthesizeMatch(state({ eligibility: elig("ineligible") }));
    expect(out.matches![0]!.concerns.some((c) => /ineligible/i.test(c))).toBe(true);
  });
});

describe("synthesizeMatch — TrialMatch shape", () => {
  it("carries all TrialCandidate fields onto the match", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state());
    expect(out.matches![0]!.nctId).toBe("NCT0001");
    expect(out.matches![0]!.title).toBe("Drug X for T2DM");
    expect(out.matches![0]!.interventions).toEqual(["Drug X"]);
  });

  it("uses 'Mechanism evaluation unavailable' rationale fallback when state's is null", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(state({ mechanismRationale: null }));
    expect(out.matches![0]!.mechanismRationale).toMatch(/unavailable/i);
  });
});

describe("synthesizeMatch — mechanismEvidence and counterEvidenceAddressed", () => {
  it("propagates mechanismEvidence onto the TrialMatch", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({
        mechanismEvidence: [{ pmid: "A1", quote: "q", supports: "yes" }],
        literatureSupport: [
          { pmid: "A1", title: "t", url: "https://pubmed.ncbi.nlm.nih.gov/A1/", pubtype: [] },
        ],
      }),
    );
    expect(out.matches![0]!.mechanismEvidence).toEqual([
      { pmid: "A1", quote: "q", supports: "yes" },
    ]);
  });

  it("filters out evidence entries whose pmid is not in literatureSupport ∪ counterEvidence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({
        mechanismEvidence: [
          { pmid: "A1", quote: "q", supports: "yes" },
          { pmid: "INVENTED", quote: "fake", supports: "yes" },
        ],
        literatureSupport: [
          { pmid: "A1", title: "t", url: "https://pubmed.ncbi.nlm.nih.gov/A1/", pubtype: [] },
        ],
      }),
    );
    expect(out.matches![0]!.mechanismEvidence.map((e) => e.pmid)).toEqual(["A1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flags 'counter-evidence present but unaddressed' concern", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({
        counterEvidence: [
          { pmid: "X1", title: "t", url: "https://pubmed.ncbi.nlm.nih.gov/X1/", pubtype: [] },
        ],
        counterEvidenceAddressed: null,
      }),
    );
    expect(out.matches![0]!.concerns).toContain(
      "counter-evidence present but not addressed in mechanism judgment",
    );
  });

  it("propagates counterEvidenceAddressed onto the TrialMatch", async () => {
    __invoke.mockResolvedValue({ summary: "ok", concerns: [] });
    const out = await synthesizeMatch(
      state({
        counterEvidence: [
          { pmid: "X1", title: "t", url: "https://pubmed.ncbi.nlm.nih.gov/X1/", pubtype: [] },
        ],
        counterEvidenceAddressed: "Population differs.",
      }),
    );
    expect(out.matches![0]!.counterEvidenceAddressed).toBe("Population differs.");
  });
});
