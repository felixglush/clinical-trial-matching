import { describe, expect, it } from "vitest";

import {
  ELIGIBILITY_FULL_CHARS,
  EligibilityJudgmentSchema,
  eligibilityPrompt,
} from "./eligibility.js";
import type {
  PatientProfile,
  SafetyConcern,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

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
    medications: [
      {
        code: "1",
        system: "rxn",
        display: "metformin",
        events: [{ date: "2024-01-01", status: "active" }],
      },
    ],
    labs: [],
    priorTreatments: [],
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
      "Inclusion:\n- Adults 18-75 with T2DM\n- HbA1c > 7\n\nExclusion:\n- Prior insulin therapy",
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
    ...overrides,
  };
}

describe("eligibilityPrompt", () => {
  it("includes patient profile fields", () => {
    const out = eligibilityPrompt(profile(), candidate(), []);
    expect(out).toContain("65");
    expect(out).toContain("female");
    expect(out).toContain("Type 2 diabetes mellitus");
    expect(out).toContain("metformin");
  });

  it("includes the trial's eligibility criteria text", () => {
    const out = eligibilityPrompt(profile(), candidate(), []);
    expect(out).toContain("Adults 18-75");
    expect(out).toContain("Prior insulin therapy");
  });

  it("truncates eligibility text to ELIGIBILITY_FULL_CHARS", () => {
    const long = "x".repeat(ELIGIBILITY_FULL_CHARS + 500);
    const out = eligibilityPrompt(
      profile(),
      candidate({ eligibilityCriteriaText: long }),
      [],
    );
    expect(out).not.toContain(long);
    expect(out).toContain("x".repeat(ELIGIBILITY_FULL_CHARS));
  });

  it("includes safety concerns when present", () => {
    const concern: SafetyConcern = {
      drugId: "DB00072",
      drugName: "trastuzumab",
      conditionId: "MONDO:0005010",
      conditionName: "heart failure",
      relation: "contraindication",
    };
    const out = eligibilityPrompt(profile(), candidate(), [concern]);
    expect(out).toContain("contraindication");
    expect(out).toContain("trastuzumab");
    expect(out).toContain("heart failure");
  });

  it("omits the safety-concerns block when none", () => {
    const out = eligibilityPrompt(profile(), candidate(), []);
    // The block is conditional; no concern entries should appear.
    expect(out).not.toContain("contraindication");
  });
});

describe("EligibilityJudgmentSchema", () => {
  it("accepts a valid assessment", () => {
    const parsed = EligibilityJudgmentSchema.parse({
      inclusion: [{ criterion: "T2DM diagnosis", met: "yes", evidence: "active condition" }],
      exclusion: [{ criterion: "prior insulin", met: "no", evidence: "not in priorTreatments" }],
      overall: "likely_eligible",
    });
    expect(parsed.overall).toBe("likely_eligible");
  });

  it("rejects an unknown overall value", () => {
    expect(() =>
      EligibilityJudgmentSchema.parse({
        inclusion: [],
        exclusion: [],
        overall: "definitely",
      }),
    ).toThrow();
  });
});
