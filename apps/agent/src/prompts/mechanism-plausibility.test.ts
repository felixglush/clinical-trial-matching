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
  StructuredCounterEvidence,
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
function emptySce(): StructuredCounterEvidence {
  return {
    primeKgContraindications: [],
    txGnnPredContraindication: null,
    terminatedPriorTrials: [],
  };
}

function scWithTerminatedTrial(): StructuredCounterEvidence {
  return {
    primeKgContraindications: [],
    txGnnPredContraindication: null,
    terminatedPriorTrials: [
      {
        nctId: "NCT9999",
        briefTitle: "Phase III osimertinib in NSCLC",
        status: "TERMINATED",
        phase: "PHASE3",
        whyStopped: "Lack of efficacy at interim analysis.",
        completionDate: "2022-06",
        conditions: ["Non-small cell lung carcinoma"],
        interventions: ["Osimertinib"],
      },
    ],
  };
}

describe("mechanismScorePrompt (Path B)", () => {
  it("includes trial interventions and patient mechanisms", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], emptySce(), null);
    expect(out).toContain("Osimertinib");
    expect(out).toContain("EGFR");
    expect(out).toContain("ERBB signaling pathway");
  });

  it("includes KG paths in a clearly labeled block", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], emptySce(), null);
    expect(out).toContain("KG path");
    expect(out).toContain("DB09330");
    expect(out).toContain("target");
    expect(out).toContain("associated with");
  });

  it("calls out the no-path case explicitly", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [], [], emptySce(), null);
    expect(out).toMatch(/no kg path/i);
  });
});

describe("mechanismScorePrompt (v1.5) — literature blocks", () => {
  it("groups supporting literature into Tier-1, Tier-2, Tier-3 blocks", () => {
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation(), tier2Citation(), tier3Citation()],
      emptySce(),
      null,
    );
    expect(out).toContain("Tier-1");
    expect(out).toContain("Tier-2");
    expect(out).toContain("Tier-3");
    // Tier-1 should appear before Tier-2 in the output.
    expect(out.indexOf("Tier-1")).toBeLessThan(out.indexOf("Tier-2"));
    expect(out.indexOf("Tier-2")).toBeLessThan(out.indexOf("Tier-3"));
  });

  it("shows abstracts for all tiers including Tier-3 (post-3c69fcd: formatTier always shows abstracts)", () => {
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation(), tier3Citation()],
      emptySce(),
      null,
    );
    expect(out).toContain("RCT showed osimertinib");                          // Tier-1 abstract shown
    expect(out).toContain("should NOT appear in prompt for Tier-3 since we hide abstracts"); // Tier-3 abstract also shown
  });

  it("renders 'No structured counter-evidence retrieved' when SCE is empty", () => {
    const without = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation()],
      emptySce(),
      null,
    );
    expect(without).toContain("No structured counter-evidence retrieved");
  });

  it("renders terminated trial entry when SCE has a terminated trial", () => {
    const withCounter = mechanismScorePrompt(
      profile(), trial(), [mech()], [kgPath()],
      [tier1Citation()],
      scWithTerminatedTrial(),
      null,
    );
    expect(withCounter).toContain("NCT9999");
    expect(withCounter).toContain("Lack of efficacy at interim analysis.");
  });

  it("renders blank lines between multiple SCE subsections", () => {
    const fullSce: StructuredCounterEvidence = {
      primeKgContraindications: [
        { drugId: "DB001", drugName: "DrugA", conditionId: "C001", conditionName: "CondA", relation: "contraindication" as const },
      ],
      txGnnPredContraindication: 0.85,
      terminatedPriorTrials: [
        {
          nctId: "NCT01234567",
          briefTitle: "Phase 3 trial",
          status: "TERMINATED",
          phase: "PHASE3",
          whyStopped: "Lack of efficacy.",
          completionDate: "2021-08",
          conditions: ["CondA"],
          interventions: ["DrugA"],
        },
      ],
    };
    const out = mechanismScorePrompt(
      profile(), trial(), [mech()], [], [], fullSce, null,
    );
    // Each subsection header must be followed by a blank line before the next subsection
    expect(out).toMatch(/PrimeKG contraindications:[\s\S]+?\n\n\s*TxGNN repurposing model:/);
    expect(out).toMatch(/TxGNN repurposing model:[\s\S]+?\n\n\s*Prior terminated/);
  });

  it("instructs LLM to weight Tier-1 > Tier-2 > Tier-3 and address counter-evidence", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [kgPath()], [], emptySce(), null);
    expect(out).toMatch(/Tier-1.*Tier-2.*Tier-3/s);
    expect(out).toMatch(/counterEvidenceAddressed/);
  });
});

describe("mechanismScorePrompt — discovery-channel provenance block", () => {
  function repurposingCandidate(): import("@clinical-trial-matching/shared").RepurposingCandidate {
    return {
      drug: { id: "DB09330", name: "osimertinib", type: "drug" },
      originalIndications: ["non-small cell lung carcinoma"],
      rationale: "",
      supportingPaths: [
        {
          nodes: [
            { id: "DB09330", name: "osimertinib", type: "drug" },
            { id: "EGFR", name: "EGFR", type: "gene_protein" },
            { id: "MONDO:0005233", name: "NSCLC", type: "disease" },
          ],
          edges: [
            { source: "DB09330", target: "EGFR", relation: "target" },
            { source: "EGFR", target: "MONDO:0005233", relation: "associated with" },
          ],
        },
      ],
      predIndication: 0.92,
      predContraindication: 0.05,
    };
  }

  it("strategy-only candidate: announces strategy channel + explicit 'no TxGNN prediction'", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [], [], emptySce(), null);
    expect(out).toMatch(/Discovery channel\(s\): strategy/);
    expect(out).toMatch(/no TxGNN repurposing prediction is associated/);
  });

  it("repurposing candidate with TxGNN context: includes drug, predIndication, original indications, explanation path", () => {
    const repurposingTrial: TrialCandidate = {
      ...trial(),
      discoveredVia: ["repurposing"],
      repurposingDrugIds: ["DB09330"],
    };
    const out = mechanismScorePrompt(
      profile(), repurposingTrial, [mech()], [], [], emptySce(), repurposingCandidate(),
    );
    expect(out).toMatch(/Discovery channel\(s\): repurposing/);
    expect(out).toMatch(/TxGNN repurposing prediction/);
    expect(out).toContain("osimertinib");
    expect(out).toContain("DB09330");
    expect(out).toContain("0.92"); // predIndication
    expect(out).toContain("non-small cell lung carcinoma");
    expect(out).toContain("EGFR"); // from explanation path
    // predContraindication is now surfaced only via the structured counter-evidence block
    expect(out).not.toContain("predContraindication: 0.05");
  });

  it("dual-channel candidate: prompt lists both channels", () => {
    const dualTrial: TrialCandidate = {
      ...trial(),
      discoveredVia: ["strategy", "repurposing"],
      repurposingDrugIds: ["DB09330"],
    };
    const out = mechanismScorePrompt(
      profile(), dualTrial, [mech()], [], [], emptySce(), repurposingCandidate(),
    );
    expect(out).toMatch(/Discovery channel\(s\): strategy \+ repurposing/);
    expect(out).toMatch(/TxGNN repurposing prediction/);
  });

  it("repurposing-tagged candidate with no matching TxGNN record: prompt names the gap honestly (no fabricated TxGNN block)", () => {
    const repurposingTrial: TrialCandidate = {
      ...trial(),
      discoveredVia: ["repurposing"],
      repurposingDrugIds: ["DB09330"],
    };
    const out = mechanismScorePrompt(
      profile(), repurposingTrial, [mech()], [], [], emptySce(), null,
    );
    expect(out).toMatch(/no matching TxGNN prediction record/i);
    expect(out).not.toMatch(/predIndication/);
  });

  it("instructions section tells the LLM how to weigh TxGNN vs literature when they disagree", () => {
    const out = mechanismScorePrompt(profile(), trial(), [mech()], [], [], emptySce(), null);
    expect(out).toMatch(/TxGNN/);
    expect(out).toMatch(/disagree/i);
    expect(out).toMatch(/favor the literature/i);
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
