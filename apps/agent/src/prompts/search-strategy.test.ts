import { describe, expect, it } from "vitest";

import { searchStrategyPrompt } from "./search-strategy.js";
import type {
  Mechanism,
  PatientProfile,
} from "@clinical-trial-matching/shared";

function makeProfile(overrides: Partial<PatientProfile> = {}): PatientProfile {
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
    medications: [],
    labs: [],
    priorTreatments: [],
    ...overrides,
  };
}

const baseMechanism: Mechanism = {
  conditionId: "44054006",
  conditionName: "Type 2 diabetes mellitus",
  mondoId: "MONDO:0005148",
  geneTargets: [{ id: "SLC5A2", name: "SLC5A2", type: "gene_protein" }],
  pathways: [
    { id: "GO:0035623", name: "glucose reabsorption", type: "biological_process" },
  ],
  supportingPaths: [],
  rationale: "primary metabolic driver",
};

describe("searchStrategyPrompt", () => {
  it("renders demographics, conditions, and mechanisms", () => {
    const out = searchStrategyPrompt(makeProfile(), [baseMechanism], null);
    expect(out).toContain("age: 60, sex: female");
    expect(out).toContain("Type 2 diabetes mellitus");
    expect(out).toContain("SLC5A2");
    expect(out).toContain("glucose reabsorption");
    expect(out).toContain("context: primary metabolic driver");
  });

  it("flags treatment-naive when no active medications and no prior treatments", () => {
    const out = searchStrategyPrompt(makeProfile(), [baseMechanism], null);
    expect(out).toContain("Active medications:\n(none — treatment-naive)");
    expect(out).toContain("Prior treatments:\n(none recorded)");
  });

  it("renders only active/in-progress medications, skipping stopped ones", () => {
    const out = searchStrategyPrompt(
      makeProfile({
        medications: [
          {
            code: "1",
            system: "rxn",
            display: "metformin",
            events: [{ date: "2024-01-01", status: "active" }],
          },
          {
            code: "2",
            system: "rxn",
            display: "glipizide",
            events: [{ date: "2023-01-01", status: "stopped" }],
          },
          {
            code: "3",
            system: "rxn",
            display: "dapagliflozin",
            events: [{ date: "2024-06-01", status: "in-progress" }],
          },
        ],
      }),
      [baseMechanism],
      null,
    );
    expect(out).toContain("- metformin");
    expect(out).toContain("- dapagliflozin");
    expect(out).not.toContain("- glipizide");
  });

  it("renders prior treatments with date when available", () => {
    const out = searchStrategyPrompt(
      makeProfile({
        priorTreatments: [
          { code: "x", system: "rxn", display: "doxorubicin", date: "2023-04-15" },
          { code: "y", system: "rxn", display: "cyclophosphamide" },
        ],
      }),
      [baseMechanism],
      null,
    );
    expect(out).toContain("- doxorubicin (2023-04-15)");
    expect(out).toContain("- cyclophosphamide");
  });

  it("includes broadening instructions only when previousAttempt is provided", () => {
    const without = searchStrategyPrompt(makeProfile(), [baseMechanism], null);
    expect(without).not.toContain("A previous attempt yielded too few candidates");
    expect(without).toContain("broadeningApplied should be an empty list on the first attempt");

    const withPrev = searchStrategyPrompt(makeProfile(), [baseMechanism], {
      queries: ["type 2 diabetes SGLT2 phase 2"],
      filters: { phase: ["PHASE2"], status: ["RECRUITING"] },
      attempt: 1,
      broadeningApplied: [],
    });
    expect(withPrev).toContain("A previous attempt yielded too few candidates");
    expect(withPrev).toContain("Previous attempt (attempt 1)");
    expect(withPrev).toContain("type 2 diabetes SGLT2 phase 2");
  });

  it("instructs the model not to put drug names in queries", () => {
    const out = searchStrategyPrompt(makeProfile(), [baseMechanism], null);
    expect(out).toContain("Do NOT put drug names");
  });

  it("instructs the model to use age/sex for filters only", () => {
    const out = searchStrategyPrompt(makeProfile(), [baseMechanism], null);
    expect(out).toContain("Use age and sex to inform FILTERS, not queries");
  });
});
