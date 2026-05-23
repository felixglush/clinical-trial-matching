import { describe, expect, it } from "vitest";

import {
  MechanismPlausibilityJudgmentSchema,
  mechanismScorePrompt,
} from "./mechanism-plausibility.js";
import type {
  KGPath,
  Mechanism,
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
    title: "Osimertinib in EGFR-mutated NSCLC",
    conditions: ["Non-small cell lung carcinoma"],
    interventions: ["Osimertinib"],
    status: "RECRUITING",
    locations: [],
    discoveredVia: ["strategy"],
    repurposingDrugIds: [],
    stdAges: [],
  };
}

function mech(): Mechanism {
  return {
    conditionId: "254637007",
    conditionName: "non-small cell lung carcinoma",
    mondoId: "MONDO:0005233",
    geneTargets: [{ id: "EGFR", name: "EGFR", type: "gene_protein" }],
    pathways: [{ id: "GO:0038127", name: "ERBB signaling pathway", type: "biological_process" }],
    supportingPaths: [],
    rationale: "EGFR mutations drive NSCLC.",
  };
}

function kgPath(): KGPath {
  return {
    nodes: [
      { id: "DB09330", name: "osimertinib", type: "drug" },
      { id: "EGFR", name: "EGFR", type: "gene_protein" },
      { id: "MONDO:0005233", name: "non-small cell lung carcinoma", type: "disease" },
    ],
    edges: [
      { source: "DB09330", target: "EGFR", relation: "target" },
      { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
    ],
  };
}

describe("mechanismScorePrompt (Path B)", () => {
  it("includes trial interventions and patient mechanisms", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()]);
    expect(out).toContain("Osimertinib");
    expect(out).toContain("EGFR");
    expect(out).toContain("ERBB signaling pathway");
  });

  it("includes KG paths in a clearly labeled block", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()]);
    expect(out).toContain("KG path");
    expect(out).toContain("DB09330");
    expect(out).toContain("target");
    expect(out).toContain("associated with");
  });

  it("calls out the no-path case explicitly", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], []);
    expect(out).toMatch(/no kg path/i);
  });
});

describe("MechanismPlausibilityJudgmentSchema", () => {
  it("accepts a valid judgment", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 85,
      rationale: "EGFR is targeted by osimertinib...",
    });
    expect(parsed.score).toBe(85);
  });

  it("rejects scores outside 0..100", () => {
    expect(() =>
      MechanismPlausibilityJudgmentSchema.parse({ score: 150, rationale: "x" }),
    ).toThrow();
  });
});
