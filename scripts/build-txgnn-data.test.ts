import { describe, expect, it } from "vitest";

import { filterAndShape, type RawRow, type RawExplanation } from "./build-txgnn-data.js";

describe("filterAndShape", () => {
  it("filters by predIndication > 0.5", () => {
    const raw: RawRow[] = [
      { disease: "MONDO:1", drugId: "DB1", drugName: "alpha",  pi: 0.91, pc: 0.10 },
      { disease: "MONDO:1", drugId: "DB2", drugName: "beta",   pi: 0.30, pc: 0.05 },
    ];
    const out = filterAndShape(raw, { topKPerDisease: 50 });
    expect(out.predictions["MONDO:1"]).toHaveLength(1);
    expect(out.predictions["MONDO:1"]![0]!.drugId).toBe("DB1");
  });

  it("filters by predContraindication >= predIndication", () => {
    const raw: RawRow[] = [
      { disease: "MONDO:1", drugId: "DB3", drugName: "gamma", pi: 0.55, pc: 0.80 },
      { disease: "MONDO:1", drugId: "DB4", drugName: "delta", pi: 0.55, pc: 0.30 },
    ];
    const out = filterAndShape(raw, { topKPerDisease: 50 });
    expect(out.predictions["MONDO:1"]!.map((p) => p.drugId)).toEqual(["DB4"]);
  });

  it("sorts and caps top-K per disease", () => {
    const raw: RawRow[] = Array.from({ length: 60 }, (_, i) => ({
      disease: "MONDO:1",
      drugId: `DB${i}`,
      drugName: `d${i}`,
      pi: 0.51 + i / 1000,
      pc: 0.10,
    }));
    const out = filterAndShape(raw, { topKPerDisease: 50 });
    expect(out.predictions["MONDO:1"]).toHaveLength(50);
    expect(out.predictions["MONDO:1"]![0]!.drugId).toBe("DB59");
  });

  it("preserves explanations only for kept (disease, drug) pairs", () => {
    const raw: RawRow[] = [
      { disease: "MONDO:1", drugId: "DB1", drugName: "alpha", pi: 0.91, pc: 0.10 },
      { disease: "MONDO:1", drugId: "DB2", drugName: "beta",  pi: 0.30, pc: 0.05 },
    ];
    const rawExplanations: Record<string, RawExplanation> = {
      "MONDO:1::DB1": { nodes: [{ id: "DB1", name: "alpha", type: "drug" }], edges: [] },
      "MONDO:1::DB2": { nodes: [{ id: "DB2", name: "beta",  type: "drug" }], edges: [] },
    };
    const out = filterAndShape(raw, { topKPerDisease: 50, rawExplanations });
    expect(Object.keys(out.explanations)).toEqual(["MONDO:1::DB1"]);
  });

  it("normalizes 'gene/protein' to 'gene_protein' in explanation node types", () => {
    const raw: RawRow[] = [
      { disease: "MONDO:1", drugId: "DB1", drugName: "alpha", pi: 0.91, pc: 0.10 },
    ];
    const rawExplanations: Record<string, RawExplanation> = {
      "MONDO:1::DB1": {
        nodes: [{ id: "X", name: "X", type: "gene/protein" }],
        edges: [],
      },
    };
    const out = filterAndShape(raw, { topKPerDisease: 50, rawExplanations });
    expect(out.explanations["MONDO:1::DB1"]!.nodes[0]!.type).toBe("gene_protein");
  });
});
