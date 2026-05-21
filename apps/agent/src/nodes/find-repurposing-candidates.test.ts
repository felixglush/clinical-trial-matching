import { beforeEach, describe, expect, it, vi } from "vitest";

import { findRepurposingCandidates } from "./find-repurposing-candidates.js";
import { __setFixturesForTests } from "../tools/txgnn.js";
import type { AgentStateType } from "../state.js";
import type { KGPath, Mechanism } from "@clinical-trial-matching/shared";

import predictionsFixture from "../tools/__fixtures__/txgnn-predictions-fixture.json" with { type: "json" };
import explanationsFixture from "../tools/__fixtures__/txgnn-explanations-fixture.json" with { type: "json" };

beforeEach(() => {
  __setFixturesForTests(
    predictionsFixture as unknown as Parameters<typeof __setFixturesForTests>[0],
    explanationsFixture as unknown as Record<string, KGPath>,
  );
});

function mech(input: {
  snomed: string;
  mondoId: string;
  name: string;
}): Mechanism {
  return {
    conditionId: input.snomed,
    conditionName: input.name,
    mondoId: input.mondoId,
    geneTargets: [],
    pathways: [],
    supportingPaths: [],
    rationale: "",
  };
}

function stateWithMechanisms(mechanisms: Mechanism[]): AgentStateType {
  return { mechanisms } as unknown as AgentStateType;
}

describe("findRepurposingCandidates", () => {
  it("emits top-N TxGNN drugs per mechanism", async () => {
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const candidates = out.repurposingCandidates ?? [];
    expect(candidates.map((c) => c.drug.id).sort()).toEqual([
      "DB00331",
      "DB01067",
      "DB06292",
    ]);
    const metformin = candidates.find((c) => c.drug.id === "DB00331");
    expect(metformin!.predIndication).toBe(0.94);
    expect(metformin!.rationale).toContain("TxGNN");
  });

  it("dedupes across mechanisms by drug.id, keeping the highest predIndication", async () => {
    __setFixturesForTests(
      {
        ...predictionsFixture,
        "MONDO:0005300": [
          { drugId: "DB00331", drugName: "metformin", predIndication: 0.75, predContraindication: 0.20 },
        ],
      } as unknown as Parameters<typeof __setFixturesForTests>[0],
      explanationsFixture as unknown as Record<string, KGPath>,
    );
    const state = stateWithMechanisms([
      mech({ snomed: "44054006",  mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
      mech({ snomed: "709044004", mondoId: "MONDO:0005300", name: "chronic kidney disease" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const metformin = out.repurposingCandidates?.filter(
      (c) => c.drug.id === "DB00331",
    );
    expect(metformin).toHaveLength(1);
    expect(metformin![0]!.predIndication).toBe(0.94);
    expect(metformin![0]!.originalIndications.sort()).toEqual([
      "chronic kidney disease",
      "type 2 diabetes mellitus",
    ]);
  });

  it("attaches the explanation path when one is distributed", async () => {
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const dapa = out.repurposingCandidates?.find((c) => c.drug.id === "DB06292");
    expect(dapa!.supportingPaths).toHaveLength(1);
    expect(dapa!.supportingPaths[0]!.nodes).toHaveLength(4);
  });

  it("leaves supportingPaths empty when no explanation is distributed", async () => {
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    const metformin = out.repurposingCandidates?.find((c) => c.drug.id === "DB00331");
    expect(metformin!.supportingPaths).toEqual([]);
  });

  it("returns empty list when state.mechanisms is empty", async () => {
    const state = stateWithMechanisms([]);
    const out = await findRepurposingCandidates(state);
    expect(out.repurposingCandidates).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it("logs and continues when a mechanism's MONDO id is uncovered", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = stateWithMechanisms([
      mech({ snomed: "999999", mondoId: "MONDO:9999999", name: "made-up disease" }),
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    expect(out.repurposingCandidates).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("MONDO:9999999"),
    );
    warnSpy.mockRestore();
  });

  it("returns {error} when TxGNN data is unloadable", async () => {
    const txgnn = await import("../tools/txgnn.js");
    const spy = vi
      .spyOn(txgnn, "ensureTxgnnLoaded")
      .mockRejectedValue(new Error("TxGNN data files missing"));
    const state = stateWithMechanisms([
      mech({ snomed: "44054006", mondoId: "MONDO:0005148", name: "type 2 diabetes mellitus" }),
    ]);
    const out = await findRepurposingCandidates(state);
    expect(out.error).toMatch(/TxGNN data files missing/);
    expect(out.repurposingCandidates).toBeUndefined();
    spy.mockRestore();
  });
});
