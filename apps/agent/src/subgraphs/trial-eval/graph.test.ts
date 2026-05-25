import { describe, expect, it, vi } from "vitest";

vi.mock("../../llm.js", () => ({
  llm: {
    withStructuredOutput: () => ({ invoke: vi.fn() }),
  },
}));

import { trialEvalGraph } from "./graph.js";

describe("trial-eval subgraph wiring", () => {
  it("includes the 6 expected nodes (plus __start__ / __end__)", () => {
    const graph = trialEvalGraph.getGraph();
    const nodeNames = Object.values(graph.nodes)
      .map((n) => n.id)
      .sort();
    expect(nodeNames).toEqual(
      [
        "__start__",
        "__end__",
        "eligibility-check",
        "literature-support",
        "gather-counter-evidence",
        "mechanism-plausibility",
        "synthesize-match",
      ].sort(),
    );
  });

  it("orders edges: start → eligibility-check → {literature-support, gather-counter-evidence} ⇄ mechanism-plausibility → synthesize-match → end", () => {
    const graph = trialEvalGraph.getGraph();
    const edges = graph.edges.map((e) => `${e.source}→${e.target}`);

    expect(edges).toContain("__start__→eligibility-check");
    // Fan out: both literature-support and gather-counter-evidence from eligibility-check
    expect(edges).toContain("eligibility-check→literature-support");
    expect(edges).toContain("eligibility-check→gather-counter-evidence");
    // Both fan in to mechanism-plausibility
    expect(edges).toContain("gather-counter-evidence→mechanism-plausibility");
    // mechanism-plausibility comes AFTER both predecessors.
    expect(edges).toContain("mechanism-plausibility→synthesize-match");
    expect(edges).toContain("synthesize-match→__end__");
    // The decide-if-more-evidence conditional adds both branches as edges:
    // literature-support→literature-support (cycle) and
    // literature-support→mechanism-plausibility (proceed).
    expect(
      edges.filter((e) => e === "literature-support→mechanism-plausibility"),
    ).toHaveLength(1);
    expect(
      edges.filter((e) => e === "literature-support→literature-support"),
    ).toHaveLength(1);
  });

  it("does NOT contain the legacy mechanism-plausibility → literature-support edge", () => {
    const graph = trialEvalGraph.getGraph();
    const edges = graph.edges.map((e) => `${e.source}→${e.target}`);
    expect(edges).not.toContain("mechanism-plausibility→literature-support");
    expect(edges).not.toContain("eligibility-check→mechanism-plausibility");
    expect(edges).not.toContain("literature-support→synthesize-match");
  });
});
