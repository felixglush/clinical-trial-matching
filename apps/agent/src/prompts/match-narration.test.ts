import { describe, expect, it } from "vitest";

import {
  MatchNarrationSchema,
  matchNarrationPrompt,
  type MatchNarrationInput,
} from "./match-narration.js";
import type {
  EligibilityAssessment,
  PatientProfile,
  TrialCandidate,
} from "@clinical-trial-matching/shared";

function profile(): PatientProfile {
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
  };
}

function trial(): TrialCandidate {
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
  };
}

function elig(overall: EligibilityAssessment["overall"]): EligibilityAssessment {
  return {
    inclusion: [{ criterion: "T2DM", met: "yes", evidence: "active condition" }],
    exclusion: [],
    overall,
    safetyConcerns: [],
  };
}

function input(overrides: Partial<MatchNarrationInput> = {}): MatchNarrationInput {
  return {
    profile: profile(),
    candidate: trial(),
    eligibility: elig("likely_eligible"),
    mechanismScore: 80,
    mechanismRationale: "Drug X targets the patient's GLP-1 pathway. See [12345].",
    sub: { eligibilityScore: 75, mechanismScore: 80, total: 77 },
    discoveredViaRepurposing: false,
    ...overrides,
  };
}

describe("matchNarrationPrompt", () => {
  it("includes both sub-scores and the total", () => {
    const out = matchNarrationPrompt(input());
    expect(out).toContain("75"); // eligibility sub-score
    expect(out).toContain("80"); // mechanism sub-score
    expect(out).toContain("77"); // total
  });

  it("does NOT include a literature sub-score line (literature is not in the formula)", () => {
    const out = matchNarrationPrompt(input());
    expect(out).not.toMatch(/literature:\s+\d+\/100/);
  });

  it("includes eligibility overall + first criterion failures", () => {
    const out = matchNarrationPrompt(
      input({
        eligibility: {
          inclusion: [{ criterion: "T2DM", met: "no", evidence: "not in conditions" }],
          exclusion: [],
          overall: "likely_ineligible",
          safetyConcerns: [],
        },
      }),
    );
    expect(out).toContain("likely_ineligible");
    expect(out).toContain("T2DM");
  });

  it("calls out the repurposing discovery channel when applicable", () => {
    const out = matchNarrationPrompt(input({ discoveredViaRepurposing: true }));
    expect(out).toMatch(/repurpos/i);
  });

  it("does not include a supporting-literature block (mechanism rationale carries citations)", () => {
    const out = matchNarrationPrompt(input());
    expect(out).not.toMatch(/supporting literature/i);
    expect(out).not.toMatch(/citation\(s\)/i);
    expect(out).not.toMatch(/no citations found/i);
  });
});

describe("MatchNarrationSchema", () => {
  it("accepts a valid narration", () => {
    const parsed = MatchNarrationSchema.parse({
      summary: "Drug X is a plausible match.",
      concerns: ["patient is borderline age"],
    });
    expect(parsed.concerns).toHaveLength(1);
  });

  it("accepts empty concerns", () => {
    const parsed = MatchNarrationSchema.parse({ summary: "x", concerns: [] });
    expect(parsed.concerns).toEqual([]);
  });
});
