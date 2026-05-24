import { describe, expect, it } from "vitest";
import type { RepurposingCandidate } from "@clinical-trial-matching/shared";
import { pickSource } from "./repurposing.js";

function rc(id: string, predIndication: number): RepurposingCandidate {
  return {
    drug: { id, name: id, type: "drug" },
    originalIndications: [],
    predIndication,
    predContraindication: 0,
    supportingPaths: [],
    rationale: "",
  } as RepurposingCandidate;
}

describe("pickSource", () => {
  it("returns undefined when no candidate matches the drugIds", () => {
    expect(pickSource(["DB1"], [rc("DB2", 0.9)])).toBeUndefined();
  });

  it("returns the matching candidate when drugIds has one match", () => {
    const candidates = [rc("DB1", 0.5), rc("DB2", 0.9)];
    expect(pickSource(["DB2"], candidates)?.drug.id).toBe("DB2");
  });

  it("returns the highest-predIndication candidate when multiple match", () => {
    const candidates = [rc("DB1", 0.5), rc("DB2", 0.9), rc("DB3", 0.7)];
    expect(pickSource(["DB1", "DB2", "DB3"], candidates)?.drug.id).toBe("DB2");
  });

  it("treats missing predIndication as 0", () => {
    const a = { ...rc("DB1", 0), predIndication: undefined } as RepurposingCandidate;
    const b = rc("DB2", 0.1);
    expect(pickSource(["DB1", "DB2"], [a, b])?.drug.id).toBe("DB2");
  });
});
