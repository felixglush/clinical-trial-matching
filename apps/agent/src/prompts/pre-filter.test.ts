import { describe, expect, it } from "vitest";

import {
  ELIGIBILITY_EXCERPT_CHARS,
  PreFilterJudgmentSchema,
  preFilterPrompt,
} from "./pre-filter.js";
import type {
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

function profile(overrides: Partial<PatientProfile> = {}): PatientProfile {
  return {
    id: "p1",
    displayName: "Test Patient",
    ageYears: 60,
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
    medications: [
      {
        code: "1",
        system: "rxn",
        display: "metformin",
        events: [{ date: "2024-01-01", status: "active" }],
      },
    ],
    labs: [],
    priorTreatments: [
      { code: "x", system: "rxn", display: "doxorubicin", date: "2023-04-15" },
    ],
    ...overrides,
  };
}

function candidate(overrides: Partial<TrialCandidate> = {}): TrialCandidate {
  return {
    nctId: "NCT0001",
    title: "Drug X for T2DM",
    conditions: ["Type 2 Diabetes Mellitus"],
    interventions: ["Drug X"],
    status: "RECRUITING",
    locations: [],
    eligibilityCriteriaText:
      "Inclusion: age 18-75 with T2DM\nExclusion: prior insulin therapy",
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    ...overrides,
  };
}

describe("preFilterPrompt", () => {
  it("includes patient age and sex", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toContain("age 60");
    expect(out).toContain("sex female");
  });

  it("includes active conditions, medications, and prior treatments", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toContain("Type 2 diabetes mellitus");
    expect(out).toContain("metformin");
    expect(out).toContain("doxorubicin");
  });

  it("includes the trial's title, conditions, interventions, and eligibility excerpt", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toContain("Drug X for T2DM");
    expect(out).toContain("Type 2 Diabetes Mellitus");
    expect(out).toContain("Drug X");
    expect(out).toContain("prior insulin therapy");
  });

  it("truncates eligibility text to ELIGIBILITY_EXCERPT_CHARS", () => {
    const long = "x".repeat(ELIGIBILITY_EXCERPT_CHARS + 500);
    const out = preFilterPrompt(profile(), candidate({ eligibilityCriteriaText: long }));
    expect(out).not.toContain(long);
    expect(out).toContain("x".repeat(ELIGIBILITY_EXCERPT_CHARS));
  });

  it("handles missing eligibility text gracefully", () => {
    const out = preFilterPrompt(
      profile(),
      candidate({ eligibilityCriteriaText: undefined }),
    );
    expect(out).toContain("eligibility criteria");
    expect(out).toContain("(none)");
  });

  it("instructs the model to KEEP when in doubt", () => {
    const out = preFilterPrompt(profile(), candidate());
    expect(out).toMatch(/when in doubt.*keep/i);
  });
});

describe("PreFilterJudgmentSchema", () => {
  it("accepts a valid drop", () => {
    const parsed = PreFilterJudgmentSchema.parse({
      keep: false,
      reason: "requires prior anti-PD-1 therapy patient hasn't had",
    });
    expect(parsed.keep).toBe(false);
  });

  it("accepts a keep with empty reason", () => {
    const parsed = PreFilterJudgmentSchema.parse({ keep: true, reason: "" });
    expect(parsed.keep).toBe(true);
  });

  it("rejects when keep is missing", () => {
    expect(() =>
      PreFilterJudgmentSchema.parse({ reason: "x" }),
    ).toThrow();
  });
});
