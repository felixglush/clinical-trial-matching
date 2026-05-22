import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchTrials } from "./search-trials.js";
import type { AgentStateType } from "../state.js";
import type {
  RepurposingCandidate,
  SearchStrategy,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

import * as ctgov from "../tools/clinicaltrials.js";

afterEach(() => vi.restoreAllMocks());

function strategy(queries: string[]): SearchStrategy {
  return {
    queries,
    filters: { status: ["RECRUITING"] },
    attempt: 1,
    broadeningApplied: [],
  };
}

function repurposing(drugId: string, drugName: string): RepurposingCandidate {
  return {
    drug: { id: drugId, name: drugName, type: "drug" },
    originalIndications: ["x"],
    rationale: "",
    supportingPaths: [],
    predIndication: 0.9,
    predContraindication: 0.1,
  };
}

function trial(nctId: string): TrialCandidate {
  return {
    nctId,
    title: `Trial ${nctId}`,
    conditions: [],
    interventions: [],
    status: "RECRUITING",
    locations: [],
    // The tool returns these as undefined; assertions on them happen in
    // tool tests, not here.
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
  } as TrialCandidate;
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    searchStrategy: strategy(["t2dm"]),
    repurposingCandidates: [],
    ...overrides,
  } as unknown as AgentStateType;
}

describe("searchTrials", () => {
  it("returns {error} when searchStrategy is null", async () => {
    const out = await searchTrials(
      makeState({ searchStrategy: null }),
    );
    expect(out.error).toMatch(/search strategy/i);
  });

  it("attaches discoveredVia=['strategy'] to strategy-only hits", async () => {
    vi.spyOn(ctgov, "searchClinicalTrials").mockResolvedValue([trial("NCT1")]);
    const out = await searchTrials(makeState());
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.discoveredVia).toEqual(["strategy"]);
    expect(out.candidates![0]!.repurposingDrugIds).toEqual([]);
  });

  it("attaches discoveredVia=['repurposing'] + drug ids to repurposing-only hits", async () => {
    const spy = vi.spyOn(ctgov, "searchClinicalTrials");
    spy.mockImplementation(async (q) => {
      if (q.term) return [];
      if (q.intervention === "metformin") return [trial("NCT2")];
      return [];
    });
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    const c = out.candidates!.find((t) => t.nctId === "NCT2")!;
    expect(c.discoveredVia).toEqual(["repurposing"]);
    expect(c.repurposingDrugIds).toEqual(["DB00331"]);
  });

  it("unions both channels for a shared NCT id", async () => {
    const spy = vi.spyOn(ctgov, "searchClinicalTrials");
    spy.mockImplementation(async (q) => {
      if (q.term) return [trial("NCT3")];
      if (q.intervention === "metformin") return [trial("NCT3")];
      return [];
    });
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.discoveredVia.sort()).toEqual([
      "repurposing",
      "strategy",
    ]);
    expect(out.candidates![0]!.repurposingDrugIds).toEqual(["DB00331"]);
  });

  it("merges repurposingDrugIds when two candidates surface the same trial", async () => {
    vi.spyOn(ctgov, "searchClinicalTrials").mockImplementation(async (q) => {
      if (q.term) return [];
      if (q.intervention === "metformin") return [trial("NCT4")];
      if (q.intervention === "dapagliflozin") return [trial("NCT4")];
      return [];
    });
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [
          repurposing("DB00331", "metformin"),
          repurposing("DB06292", "dapagliflozin"),
        ],
      }),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.repurposingDrugIds.sort()).toEqual([
      "DB00331",
      "DB06292",
    ]);
  });

  it("issues one CT.gov call per query in searchStrategy.queries", async () => {
    const spy = vi.spyOn(ctgov, "searchClinicalTrials").mockResolvedValue([]);
    await searchTrials(
      makeState({ searchStrategy: strategy(["q1", "q2", "q3"]) }),
    );
    const termCalls = spy.mock.calls.filter((c) => c[0].term !== undefined);
    expect(termCalls.map((c) => c[0].term).sort()).toEqual(["q1", "q2", "q3"]);
  });

  it("soft-degrades when one strategy call fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ctgov, "searchClinicalTrials").mockImplementation(async (q) => {
      if (q.term === "bad") throw new Error("CT.gov 500");
      return [trial("NCT5")];
    });
    const out = await searchTrials(
      makeState({ searchStrategy: strategy(["good", "bad"]) }),
    );
    expect(out.candidates!.map((t) => t.nctId)).toEqual(["NCT5"]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns {error} when both channels totally fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(ctgov, "searchClinicalTrials").mockRejectedValue(
      new Error("network down"),
    );
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    expect(out.error).toMatch(/CT\.gov/i);
  });

  it("returns {candidates: []} when both channels return empty (not an error)", async () => {
    vi.spyOn(ctgov, "searchClinicalTrials").mockResolvedValue([]);
    const out = await searchTrials(
      makeState({
        repurposingCandidates: [repurposing("DB00331", "metformin")],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it("runs the repurposing channel with bounded concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(ctgov, "searchClinicalTrials").mockImplementation(async (q) => {
      if (!q.intervention) return [];
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [];
    });
    const candidates = Array.from({ length: 25 }, (_, i) =>
      repurposing(`D${i}`, `drug${i}`),
    );
    await searchTrials(makeState({ repurposingCandidates: candidates }));
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });
});
