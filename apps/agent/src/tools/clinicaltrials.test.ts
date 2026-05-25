import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchClinicalTrials, searchTerminatedPriorTrials } from "./clinicaltrials.js";
import fixture from "./__fixtures__/ctgov-study-fixture.json" with { type: "json" };

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("searchClinicalTrials", () => {
  it("maps a v2 study payload into a TrialCandidate", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse(fixture));
    const [t] = await searchClinicalTrials({ term: "type 2 diabetes" });
    expect(t!.nctId).toBe("NCT00000001");
    expect(t!.title).toBe("A Study of Drug X in Type 2 Diabetes");
    expect(t!.status).toBe("RECRUITING");
    expect(t!.phase).toBe("PHASE2");
    expect(t!.conditions).toEqual(["Type 2 Diabetes Mellitus"]);
    expect(t!.interventions).toEqual(["Drug X", "Metformin"]);
    expect(t!.minimumAge).toBe("18 Years");
    expect(t!.maximumAge).toBe("75 Years");
    expect(t!.minimumAgeYears).toBe(18);
    expect(t!.maximumAgeYears).toBe(75);
    expect(t!.stdAges).toEqual(["ADULT", "OLDER_ADULT"]);
    expect(t!.sexEligibility).toBe("ALL");
    expect(t!.eligibilityCriteriaText).toContain("Inclusion: adults");
    expect(t!.locations).toHaveLength(1);
    expect(t!.locations[0]!.city).toBe("Boston");
  });

  it("does not populate discoveredVia or repurposingDrugIds (caller does)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse(fixture));
    const [t] = await searchClinicalTrials({ term: "x" });
    expect(t!.discoveredVia).toBeUndefined();
    expect(t!.repurposingDrugIds).toBeUndefined();
  });

  it("sends query.term for a term query", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ term: "diabetes" });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("query.term")).toBe("diabetes");
    expect(url.searchParams.get("query.intr")).toBeNull();
  });

  it("sends query.intr for an intervention query", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ intervention: "metformin" });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("query.intr")).toBe("metformin");
    expect(url.searchParams.get("query.term")).toBeNull();
  });

  it("pipe-joins status filter and maps single phase via filter.advanced", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({
      term: "x",
      filters: { status: ["RECRUITING", "NOT_YET_RECRUITING"], phase: ["PHASE2"] },
    });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("filter.overallStatus")).toBe("RECRUITING|NOT_YET_RECRUITING");
    expect(url.searchParams.get("filter.advanced")).toBe("AREA[Phase]PHASE2");
    expect(url.searchParams.get("filter.phase")).toBeNull();
  });

  it("maps multiple phases via filter.advanced with OR", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({
      term: "x",
      filters: { phase: ["PHASE2", "PHASE3"] },
    });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("filter.advanced")).toBe("AREA[Phase](PHASE2 OR PHASE3)");
  });

  it("defaults pageSize to 50", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ term: "x" });
    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("pageSize")).toBe("50");
  });

  it("returns [] for an empty studies array", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    const out = await searchClinicalTrials({ term: "x" });
    expect(out).toEqual([]);
  });

  it("throws on non-2xx, non-retryable status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({}, { status: 500 }));
    await expect(searchClinicalTrials({ term: "x" })).rejects.toThrow(/500/);
  });

  it("retries on 429 then returns the 200", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse({}, { status: 429 }))
      .mockResolvedValueOnce(makeResponse(fixture));
    const promise = searchClinicalTrials({ term: "x" });
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After (seconds) on 429", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(
        makeResponse({}, { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(makeResponse(fixture));
    const promise = searchClinicalTrials({ term: "x" });
    await vi.advanceTimersByTimeAsync(1000);
    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
  });

  it("gives up after 3 attempts and throws on persistent 429", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(makeResponse({}, { status: 429 }));
    const promise = searchClinicalTrials({ term: "x" });
    // Attach rejection handler before advancing timers to avoid unhandled rejection.
    const assertion = expect(promise).rejects.toThrow(/429/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("treats 503 like 429 (retries)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse({}, { status: 503 }))
      .mockResolvedValueOnce(makeResponse(fixture));
    const promise = searchClinicalTrials({ term: "x" });
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out).toHaveLength(1);
  });

  it("passes an AbortSignal to fetch (per-attempt timeout)", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(makeResponse({ studies: [] }));
    await searchClinicalTrials({ term: "x" });
    const init = spy.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("searchTerminatedPriorTrials", () => {
  it("queries CT.gov with intr + term + status filter and projects whyStopped", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: "NCT01234567", briefTitle: "Trial of X" },
              statusModule: {
                overallStatus: "TERMINATED",
                whyStopped: "Stopped early at interim analysis for lack of efficacy.",
                completionDateStruct: { date: "2021-08-15" },
              },
              conditionsModule: { conditions: ["Non-small cell lung cancer"] },
              designModule: { phases: ["PHASE3"] },
              armsInterventionsModule: { interventions: [{ name: "Osimertinib" }] },
            },
          },
        ],
      }),
    } as Response);

    const out = await searchTerminatedPriorTrials({
      intervention: "osimertinib",
      condition: "non-small cell lung cancer",
    });

    expect(out).toEqual([
      {
        nctId: "NCT01234567",
        briefTitle: "Trial of X",
        conditions: ["Non-small cell lung cancer"],
        interventions: ["Osimertinib"],
        phase: "PHASE3",
        status: "TERMINATED",
        whyStopped: "Stopped early at interim analysis for lack of efficacy.",
        completionDate: "2021-08-15",
      },
    ]);

    const calledUrl = spy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("query.intr=osimertinib");
    expect(calledUrl).toContain("query.term=non-small+cell+lung+cancer");
    expect(calledUrl).toContain("filter.overallStatus=TERMINATED%7CWITHDRAWN%7CSUSPENDED");
    expect(calledUrl).toContain("protocolSection.statusModule.whyStopped");
  });

  it("returns [] when CT.gov returns no studies", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ studies: [] }),
    } as Response);

    const out = await searchTerminatedPriorTrials({
      intervention: "obscuredrug",
      condition: "rare disease",
    });
    expect(out).toEqual([]);
  });

  it("drops studies whose overallStatus is not TERMINATED/WITHDRAWN/SUSPENDED", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        studies: [
          {
            protocolSection: {
              identificationModule: { nctId: "NCT00000001", briefTitle: "Completed trial" },
              statusModule: { overallStatus: "COMPLETED" },
              conditionsModule: { conditions: [] },
              armsInterventionsModule: { interventions: [] },
            },
          },
        ],
      }),
    } as Response);

    const out = await searchTerminatedPriorTrials({
      intervention: "drug",
      condition: "disease",
    });
    expect(out).toEqual([]);
  });

  it("drops studies missing nctId", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        studies: [
          {
            protocolSection: {
              identificationModule: {},
              statusModule: { overallStatus: "TERMINATED" },
              conditionsModule: { conditions: [] },
              armsInterventionsModule: { interventions: [] },
            },
          },
        ],
      }),
    } as Response);

    const out = await searchTerminatedPriorTrials({
      intervention: "drug",
      condition: "disease",
    });
    expect(out).toEqual([]);
  });
});
