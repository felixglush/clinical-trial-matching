import { describe, expect, it } from "vitest";

import {
  MechanismPlausibilityJudgmentSchema,
  mechanismScorePrompt,
} from "./mechanism-plausibility.js";
import type {
  Citation,
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

function tier1Citation(): Citation {
  return {
    pmid: "A1",
    title: "RCT supporting evidence",
    url: "u",
    pubtype: ["Randomized Controlled Trial"],
    abstractExcerpt: "RCT showed osimertinib superior to chemotherapy in EGFR-mutated NSCLC.",
  };
}
function tier2Citation(): Citation {
  return {
    pmid: "B1",
    title: "Cohort study",
    url: "u",
    pubtype: ["Cohort Studies"],
    abstractExcerpt: "Observational cohort confirms benefit.",
  };
}
function tier3Citation(): Citation {
  return {
    pmid: "C1",
    title: "Case report on rare resistance",
    url: "u",
    pubtype: ["Case Reports"],
    abstractExcerpt: "(should NOT appear in prompt for Tier-3 since we hide abstracts)",
  };
}
function counterCitation(): Citation {
  return {
    pmid: "X1",
    title: "Phase III trial discontinued for futility",
    url: "u",
    pubtype: ["Randomized Controlled Trial"],
    abstractExcerpt: "Trial halted due to futility at interim analysis.",
  };
}

describe("mechanismScorePrompt (Path B)", () => {
  it("includes trial interventions and patient mechanisms", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], []);
    expect(out).toContain("Osimertinib");
    expect(out).toContain("EGFR");
    expect(out).toContain("ERBB signaling pathway");
  });

  it("includes KG paths in a clearly labeled block", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], []);
    expect(out).toContain("KG path");
    expect(out).toContain("DB09330");
    expect(out).toContain("target");
    expect(out).toContain("associated with");
  });

  it("calls out the no-path case explicitly", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [], [], []);
    expect(out).toMatch(/no kg path/i);
  });
});

describe("mechanismScorePrompt (v1.5) — literature blocks", () => {
  it("groups supporting literature into Tier-1, Tier-2, Tier-3 blocks", () => {
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation(), tier2Citation(), tier3Citation()],
      [],
    );
    expect(out).toContain("Tier-1");
    expect(out).toContain("Tier-2");
    expect(out).toContain("Tier-3");
    // Tier-1 should appear before Tier-2 in the output.
    expect(out.indexOf("Tier-1")).toBeLessThan(out.indexOf("Tier-2"));
    expect(out.indexOf("Tier-2")).toBeLessThan(out.indexOf("Tier-3"));
  });

  it("shows abstracts for Tier-1 and Tier-2 but not Tier-3", () => {
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation(), tier3Citation()],
      [],
    );
    expect(out).toContain("RCT showed osimertinib");      // Tier-1 abstract shown
    expect(out).not.toContain("should NOT appear");         // Tier-3 abstract hidden
  });

  it("conditionally renders the counter-evidence block only when non-empty", () => {
    const without = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation()],
      [],
    );
    expect(without).toContain("No counter-evidence retrieved");

    const withCounter = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation()],
      [counterCitation()],
    );
    expect(withCounter).toContain("halted due to futility");
    expect(withCounter).toContain("X1");
  });

  it("instructs LLM to weight Tier-1 > Tier-2 > Tier-3 and address counter-evidence", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], []);
    expect(out).toMatch(/Tier-1.*Tier-2.*Tier-3/s);
    expect(out).toMatch(/counterEvidenceAddressed/);
  });
});

describe("MechanismPlausibilityJudgmentSchema", () => {
  it("accepts a valid judgment", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 85,
      rationale: "EGFR is targeted by osimertinib...",
      evidence: [],
    });
    expect(parsed.score).toBe(85);
  });

  // Bedrock rejects `minimum`/`maximum` on integer types in tool schemas,
  // so the schema deliberately accepts any integer. The 0-100 bound is
  // enforced post-LLM by a clamp in `nodes/mechanism-plausibility.ts`
  // (see Path B clamp tests there).
  it("accepts integer scores outside 0..100 (clamping is the node's job)", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 150,
      rationale: "x",
      evidence: [],
    });
    expect(parsed.score).toBe(150);
  });
});

describe("MechanismPlausibilityJudgmentSchema (v1.5)", () => {
  it("accepts score + rationale + evidence + counterEvidenceAddressed", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 80,
      rationale: "Strong Tier-1 evidence supports the mechanism.",
      evidence: [
        { pmid: "A1", quote: "RCT showed superior PFS.", supports: "yes" },
        { pmid: "X1", quote: "Trial halted for futility.", supports: "no" },
      ],
      counterEvidenceAddressed: "Counter-evidence trial used different patient population.",
    });
    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.counterEvidenceAddressed).toBeTruthy();
  });

  it("accepts empty evidence array", () => {
    const parsed = MechanismPlausibilityJudgmentSchema.parse({
      score: 50, rationale: "no quotable evidence", evidence: [],
    });
    expect(parsed.evidence).toEqual([]);
  });

  it("rejects invalid 'supports' enum value", () => {
    expect(() =>
      MechanismPlausibilityJudgmentSchema.parse({
        score: 50, rationale: "x",
        evidence: [{ pmid: "A1", quote: "q", supports: "maybe" }],
      }),
    ).toThrow();
  });
});
