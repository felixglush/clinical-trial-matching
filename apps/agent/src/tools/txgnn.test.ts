import { describe, expect, it } from "vitest";

import {
  __setFixturesForTests,
  isCovered,
  lookupExplanation,
  lookupPredictions,
} from "./txgnn.js";

import type { KGPath } from "@clinical-trial-matching/shared";
import type { TxGNNPrediction } from "./txgnn.js";
import predictionsFixtureRaw from "./__fixtures__/txgnn-predictions-fixture.json" with { type: "json" };
import explanationsFixtureRaw from "./__fixtures__/txgnn-explanations-fixture.json" with { type: "json" };

// Cast fixtures to their typed forms so __setFixturesForTests receives the
// correct types (JSON inference widens node `type` to `string`).
const predictionsFixture = predictionsFixtureRaw as Record<string, TxGNNPrediction[]>;
const explanationsFixture = explanationsFixtureRaw as Record<string, KGPath>;

// Inject fixtures at module top level so the production loader never runs
// during tests (those data files may not exist yet).
__setFixturesForTests(predictionsFixture, explanationsFixture);

describe("lookupPredictions", () => {
  it("returns top-N predictions for a covered MONDO id, sorted by predIndication desc", () => {
    const out = lookupPredictions("MONDO:0005148", 2);
    expect(out.map((p) => p.drugId)).toEqual(["DB00331", "DB01067"]);
    expect(out[0]!.predIndication).toBe(0.94);
  });

  it("clamps topN to the available predictions", () => {
    const out = lookupPredictions("MONDO:0005148", 99);
    expect(out).toHaveLength(3);
  });

  it("returns empty array for uncovered MONDO id", () => {
    expect(lookupPredictions("MONDO:9999999", 5)).toEqual([]);
  });
});

describe("lookupExplanation", () => {
  it("returns the KGPath for a covered (disease, drug) pair", () => {
    const path = lookupExplanation("MONDO:0005148", "DB06292");
    expect(path).not.toBeNull();
    expect(path!.nodes).toHaveLength(4);
    expect(path!.edges[0]!.relation).toBe("target");
  });

  it("returns null when no explanation is distributed for the pair", () => {
    expect(lookupExplanation("MONDO:0005148", "DB00331")).toBeNull();
  });
});

describe("isCovered", () => {
  it("returns true for a MONDO id present in predictions", () => {
    expect(isCovered("MONDO:0005148")).toBe(true);
  });

  it("returns false for an uncovered MONDO id", () => {
    expect(isCovered("MONDO:9999999")).toBe(false);
  });
});
