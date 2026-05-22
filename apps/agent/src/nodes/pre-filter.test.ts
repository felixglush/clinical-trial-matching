import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { structuredInvoke, withStructuredOutput } = vi.hoisted(() => {
  const structuredInvoke = vi.fn();
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  return { structuredInvoke, withStructuredOutput };
});
vi.mock("../llm.js", () => ({
  llm: { withStructuredOutput },
}));

import { preFilter } from "./pre-filter.js";
import type { AgentStateType } from "../state.js";
import type {
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

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
    conditions: [],
    medications: [],
    labs: [],
    priorTreatments: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT_DEFAULT",
    title: "Default",
    conditions: [],
    interventions: [],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
  return {
    patientProfile: profile(),
    candidates: [],
    ...overrides,
  } as unknown as AgentStateType;
}

describe("preFilter", () => {
  it("returns {error} when patientProfile is null", async () => {
    const out = await preFilter(makeState({ patientProfile: null }));
    expect(out.error).toMatch(/patient profile/i);
  });

  it("returns empty kept + empty drops when candidates is empty", async () => {
    const out = await preFilter(makeState({ candidates: [] }));
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops).toEqual([]);
    expect(structuredInvoke).not.toHaveBeenCalled();
  });

  it("drops on non-enrolling status (stage1)", async () => {
    const out = await preFilter(
      makeState({
        candidates: [
          candidate({ nctId: "NCT_DONE", title: "Done", status: "COMPLETED" }),
        ],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops).toHaveLength(1);
    expect(out.candidateDrops![0]).toMatchObject({
      nctId: "NCT_DONE",
      reason: "not-recruiting",
      stage: "stage1",
      detail: "COMPLETED",
    });
  });

  it("drops on minimumAge above patient age (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ ageYears: 12 }),
        candidates: [candidate({ nctId: "NCT_ADULT", minimumAge: "18 Years" })],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops![0]).toMatchObject({
      nctId: "NCT_ADULT",
      reason: "age-too-young",
      stage: "stage1",
      detail: "18 Years",
    });
  });

  it("drops on maximumAge below patient age (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ ageYears: 80 }),
        candidates: [candidate({ nctId: "NCT_KID", maximumAge: "75 Years" })],
      }),
    );
    expect(out.candidateDrops![0]).toMatchObject({
      reason: "age-too-old",
      detail: "75 Years",
    });
  });

  it("drops on sex mismatch (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ sex: "female" }),
        candidates: [candidate({ nctId: "NCT_M", sexEligibility: "MALE" })],
      }),
    );
    expect(out.candidateDrops![0]).toMatchObject({
      reason: "sex-mismatch",
      detail: "MALE",
    });
  });

  it("does not drop on sex when patient sex is 'other' or 'unknown'", async () => {
    structuredInvoke.mockResolvedValue({ keep: true, reason: "" });
    const out = await preFilter(
      makeState({
        patientProfile: profile({ sex: "unknown" }),
        candidates: [candidate({ sexEligibility: "MALE" })],
      }),
    );
    expect(out.candidates).toHaveLength(1);
  });

  it("drops everything when patient is deceased (stage1)", async () => {
    const out = await preFilter(
      makeState({
        patientProfile: profile({ deceased: true }),
        candidates: [candidate({ nctId: "NCT_X" })],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops![0]).toMatchObject({
      reason: "deceased",
      stage: "stage1",
    });
  });

  it("invokes the LLM on stage1 survivors", async () => {
    structuredInvoke.mockResolvedValue({ keep: true, reason: "" });
    await preFilter(
      makeState({ candidates: [candidate({ nctId: "NCT_KEEP" })] }),
    );
    expect(structuredInvoke).toHaveBeenCalledTimes(1);
  });

  it("drops stage2 with reason 'llm-ineligible' and LLM detail", async () => {
    structuredInvoke.mockResolvedValue({
      keep: false,
      reason: "requires prior insulin therapy",
    });
    const out = await preFilter(
      makeState({ candidates: [candidate({ nctId: "NCT_INS" })] }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops![0]).toMatchObject({
      nctId: "NCT_INS",
      reason: "llm-ineligible",
      stage: "stage2",
      detail: "requires prior insulin therapy",
    });
  });

  it("keeps the candidate on LLM error (lenient) and does NOT record a drop", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    structuredInvoke.mockRejectedValue(new Error("rate limited"));
    const out = await preFilter(
      makeState({ candidates: [candidate({ nctId: "NCT_LENIENT" })] }),
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates![0]!.nctId).toBe("NCT_LENIENT");
    expect(out.candidateDrops).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("preserves stage1 drops alongside stage2 drops in candidateDrops", async () => {
    structuredInvoke.mockResolvedValueOnce({
      keep: false,
      reason: "no kidney function ≥30 GFR",
    });
    const out = await preFilter(
      makeState({
        candidates: [
          candidate({ nctId: "NCT_DONE", status: "COMPLETED" }),
          candidate({ nctId: "NCT_LLM" }),
        ],
      }),
    );
    expect(out.candidates).toEqual([]);
    expect(out.candidateDrops).toHaveLength(2);
    const stages = out.candidateDrops!.map((d) => d.stage).sort();
    expect(stages).toEqual(["stage1", "stage2"]);
  });

  it("runs stage2 with bounded concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    structuredInvoke.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { keep: true, reason: "" };
    });
    const candidates = Array.from({ length: 25 }, (_, i) =>
      candidate({ nctId: `NCT_${i}` }),
    );
    await preFilter(makeState({ candidates }));
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });
});
