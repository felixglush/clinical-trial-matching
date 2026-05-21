import { describe, expect, it } from "vitest";
import type { PatientProfile } from "@clinical-trial-matching/shared";

import type { CandidateMechanism } from "../tools/kg.js";
import { MechanismPicksSchema, mechanismPrompt } from "./mechanism.js";

const PROFILE: PatientProfile = {
  id: "hedy-sauer",
  displayName: "Hedy Sauer",
  ageYears: 62,
  sex: "female",
  deceased: false,
  conditions: [
    {
      code: "254837009",
      system: "http://snomed.info/sct",
      display: "Malignant tumor of breast",
      clinicalStatus: "active",
    },
    {
      code: "59621000",
      system: "http://snomed.info/sct",
      display: "Hypertension",
      clinicalStatus: "active",
    },
    {
      code: "111111111",
      system: "http://snomed.info/sct",
      display: "Old resolved thing",
      clinicalStatus: "resolved",
    },
  ],
  medications: [],
  labs: [],
  priorTreatments: [],
};

const CANDIDATES: CandidateMechanism[] = [
  {
    conditionId: "254837009",
    conditionName: "Malignant tumor of breast",
    geneTargets: [
      { id: "1", name: "BRCA1", type: "gene_protein" },
      { id: "2", name: "BRCA2", type: "gene_protein" },
      { id: "3", name: "TP53", type: "gene_protein" },
    ],
    pathways: [
      { id: "P1", name: "DNA repair", type: "biological_process" },
      { id: "P2", name: "apoptosis", type: "biological_process" },
    ],
    supportingPaths: [],
  },
  {
    conditionId: "59621000",
    conditionName: "Hypertension",
    geneTargets: [{ id: "10", name: "AGT", type: "gene_protein" }],
    pathways: [
      { id: "P10", name: "blood pressure regulation", type: "biological_process" },
    ],
    supportingPaths: [],
  },
];

describe("mechanismPrompt", () => {
  const out = mechanismPrompt(PROFILE, CANDIDATES);

  it("includes patient demographics", () => {
    expect(out).toContain("Hedy Sauer");
    expect(out).toContain("62yo");
    expect(out).toContain("female");
  });

  it("lists only active conditions in the active-conditions block", () => {
    // Active items appear
    expect(out).toContain("Malignant tumor of breast (SNOMED 254837009)");
    expect(out).toContain("Hypertension (SNOMED 59621000)");
    // Resolved item must not appear at all (it isn't a candidate and isn't
    // in the active-conditions block).
    expect(out).not.toContain("Old resolved thing");
  });

  it("includes every candidate as a labeled block with id, genes, and pathways", () => {
    expect(out).toContain("[254837009] Malignant tumor of breast");
    expect(out).toContain("BRCA1");
    expect(out).toContain("DNA repair");
    expect(out).toContain("[59621000] Hypertension");
    expect(out).toContain("AGT");
    expect(out).toContain("blood pressure regulation");
  });

  it("instructs the LLM to use only the provided conditionIds", () => {
    expect(out).toContain("254837009, 59621000");
  });

  it("constrains output to at most MECHANISM_PICKS_CAP picks", () => {
    // Locks the cap into the prompt text without hardcoding the number —
    // bump MAX_PICKS in mechanism.ts and the prompt updates automatically.
    expect(out).toMatch(/Return up to \d+ picks/);
  });

  it("is deterministic for the same input (no timestamps / random)", () => {
    expect(mechanismPrompt(PROFILE, CANDIDATES)).toBe(out);
  });
});

describe("MechanismPicksSchema", () => {
  it("accepts a valid picks payload", () => {
    const parsed = MechanismPicksSchema.parse({
      picks: [
        { conditionId: "254837009", rationale: "Primary breast cancer driver." },
      ],
    });
    expect(parsed.picks).toHaveLength(1);
  });

  it("rejects picks missing rationale", () => {
    const bad = { picks: [{ conditionId: "254837009" }] };
    expect(() => MechanismPicksSchema.parse(bad)).toThrow();
  });
});
