import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PatientProfile,
} from "@clinical-trial-matching/shared";

// Replace the LLM module entirely so importing identify-relevant-mechanisms
// doesn't pull in @langchain/openai with a missing OPENROUTER_API_KEY at
// test time. The structuredInvoke mock is what individual tests configure
// to control what the LLM returns. Declared via vi.hoisted because vi.mock
// is hoisted above all `const` / `import` statements at runtime.
const { structuredInvoke, withStructuredOutput } = vi.hoisted(() => {
  const structuredInvoke = vi.fn();
  const withStructuredOutput = vi.fn(() => ({ invoke: structuredInvoke }));
  return { structuredInvoke, withStructuredOutput };
});
vi.mock("../llm.js", () => ({
  llm: { withStructuredOutput },
}));

import { identifyRelevantMechanisms } from "./identify-relevant-mechanisms.js";
import * as kg from "../tools/kg.js";
import type { AgentStateType } from "../state.js";

const PROFILE: PatientProfile = {
  id: "p",
  displayName: "P",
  ageYears: 50,
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
      code: "111111",
      system: "http://snomed.info/sct",
      display: "Resolved thing",
      clinicalStatus: "resolved",
    },
  ],
  medications: [],
  labs: [],
  priorTreatments: [],
};

function stateWith(overrides: Partial<AgentStateType>): AgentStateType {
  return {
    patientId: "p",
    patientProfile: PROFILE,
    mechanisms: [],
    mechanismDrops: [],
    repurposingCandidates: [],
    searchStrategy: null,
    candidates: [],
    matches: [],
    attempts: 0,
    approvalRequest: null,
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  structuredInvoke.mockReset();
  withStructuredOutput.mockClear();
});

describe("identifyRelevantMechanisms", () => {
  it("returns an error when patientProfile is missing", async () => {
    const out = await identifyRelevantMechanisms(stateWith({ patientProfile: null }));
    expect(out.error).toMatch(/No patient profile/);
  });

  it("returns empty mechanisms when no active conditions remain after filter", async () => {
    const profile: PatientProfile = {
      ...PROFILE,
      conditions: [
        {
          code: "111111",
          system: "http://snomed.info/sct",
          display: "Resolved",
          clinicalStatus: "resolved",
        },
      ],
    };
    // KG must NOT be called when there's nothing to query.
    const kgSpy = vi
      .spyOn(kg, "buildCandidateMechanisms")
      .mockResolvedValue({ candidates: [], unresolved: [] });
    const out = await identifyRelevantMechanisms(
      stateWith({ patientProfile: profile }),
    );
    expect(out.mechanisms).toEqual([]);
    expect(kgSpy).not.toHaveBeenCalled();
  });

  it("returns empty mechanisms when KG produces zero candidates", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [],
      unresolved: ["254837009"],
    });
    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.mechanisms).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it("returns error when KG query throws", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockRejectedValue(
      new Error("Neo4j connection refused"),
    );
    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.error).toMatch(/Failed to query KG.*Neo4j connection refused/);
  });

  it("returns ordered mechanisms with rationale when the LLM produces picks", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [
        {
          conditionId: "254837009",
          conditionName: "Breast cancer",
          mondoId: "MONDO:0007254",
          geneTargets: [{ id: "1", name: "BRCA1", type: "gene_protein" }],
          pathways: [{ id: "P1", name: "DNA repair", type: "biological_process" }],
          supportingPaths: [],
        },
        {
          conditionId: "59621000",
          conditionName: "Hypertension",
          mondoId: "MONDO:0001134",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
      ],
      unresolved: [],
    });

    const fakeInvoke = vi.fn().mockResolvedValue({
      picks: [
        { conditionId: "254837009", rationale: "BRCA1 driver." },
      ],
    });
    structuredInvoke.mockImplementation(fakeInvoke);

    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.mechanisms).toHaveLength(1);
    const first = out.mechanisms![0]!;
    expect(first.conditionId).toBe("254837009");
    expect(first.rationale).toBe("BRCA1 driver.");
    expect(first.geneTargets[0]!.name).toBe("BRCA1");
  });

  it("dedupes picks with the same conditionId, keeping the first", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [
        {
          conditionId: "254837009",
          conditionName: "Breast cancer",
          mondoId: "MONDO:0007254",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
      ],
      unresolved: [],
    });
    structuredInvoke.mockResolvedValue({
      picks: [
        { conditionId: "254837009", rationale: "first" },
        { conditionId: "254837009", rationale: "second (should be dropped)" },
      ],
    });
    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.mechanisms).toHaveLength(1);
    expect(out.mechanisms![0]!.rationale).toBe("first");
  });

  it("skips picks whose conditionId is not in the candidate set", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [
        {
          conditionId: "254837009",
          conditionName: "Breast cancer",
          mondoId: "MONDO:0007254",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
      ],
      unresolved: [],
    });
    structuredInvoke.mockResolvedValue({
      picks: [
        { conditionId: "254837009", rationale: "ok" },
        { conditionId: "made-up-id", rationale: "noise" },
      ],
    });
    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.mechanisms).toHaveLength(1);
    expect(out.mechanisms![0]!.conditionId).toBe("254837009");
  });

  it("records inactive conditions as drops with reason='inactive'", async () => {
    // PROFILE has one active (254837009) and one resolved (111111).
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [
        {
          conditionId: "254837009",
          conditionName: "Malignant tumor of breast",
          mondoId: "MONDO:0007254",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
      ],
      unresolved: [],
    });
    structuredInvoke.mockResolvedValue({
      picks: [{ conditionId: "254837009", rationale: "ok" }],
    });
    const out = await identifyRelevantMechanisms(stateWith({}));
    const drops = out.mechanismDrops ?? [];
    expect(drops).toContainEqual({
      code: "111111",
      display: "Resolved thing",
      reason: "inactive",
      detail: "clinicalStatus=resolved",
    });
  });

  it("records crosswalk-unresolved active conditions as drops with reason='unresolved'", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [],
      unresolved: ["254837009"],
    });
    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.mechanismDrops).toContainEqual({
      code: "254837009",
      display: "Malignant tumor of breast",
      reason: "unresolved",
      detail: "no MONDO entry in SNOMED→PrimeKG crosswalk",
    });
  });

  it("records candidates not picked by the LLM as drops with reason='not-picked'", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [
        {
          conditionId: "254837009",
          conditionName: "Breast cancer",
          mondoId: "MONDO:0007254",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
        {
          conditionId: "59621000",
          conditionName: "Hypertension",
          mondoId: "MONDO:0001134",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
      ],
      unresolved: [],
    });
    structuredInvoke.mockResolvedValue({
      picks: [{ conditionId: "254837009", rationale: "primary" }],
    });
    const out = await identifyRelevantMechanisms(stateWith({}));
    const notPicked = (out.mechanismDrops ?? []).filter(
      (d) => d.reason === "not-picked",
    );
    expect(notPicked).toHaveLength(1);
    expect(notPicked[0]!.code).toBe("59621000");
    expect(notPicked[0]!.display).toBe("Hypertension");
  });

  it("returns an error when LLM call throws", async () => {
    vi.spyOn(kg, "buildCandidateMechanisms").mockResolvedValue({
      candidates: [
        {
          conditionId: "254837009",
          conditionName: "Breast cancer",
          mondoId: "MONDO:0007254",
          geneTargets: [],
          pathways: [],
          supportingPaths: [],
        },
      ],
      unresolved: [],
    });
    structuredInvoke.mockRejectedValue(new Error("upstream LLM 500"));
    const out = await identifyRelevantMechanisms(stateWith({}));
    expect(out.error).toMatch(/Failed to rank mechanisms.*upstream LLM 500/);
  });
});
