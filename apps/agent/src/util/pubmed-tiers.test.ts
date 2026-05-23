import { describe, expect, it } from "vitest";
import { TIER1_PUBTYPES, TIER3_PUBTYPES, tierForCitation, tierLabel } from "./pubmed-tiers.js";

describe("tierForCitation", () => {
  it("returns 1 for RCT / meta-analysis / systematic review", () => {
    expect(tierForCitation({ pubtype: ["Randomized Controlled Trial"] })).toBe(1);
    expect(tierForCitation({ pubtype: ["Meta-Analysis"] })).toBe(1);
    expect(tierForCitation({ pubtype: ["Systematic Review"] })).toBe(1);
  });

  it("returns 3 for case reports / editorials / comments", () => {
    expect(tierForCitation({ pubtype: ["Case Reports"] })).toBe(3);
    expect(tierForCitation({ pubtype: ["Editorial"] })).toBe(3);
    expect(tierForCitation({ pubtype: ["Letter"] })).toBe(3);
  });

  it("defaults to 2 for unknown pubtypes", () => {
    expect(tierForCitation({ pubtype: ["Journal Article"] })).toBe(2);
    expect(tierForCitation({ pubtype: [] })).toBe(2);
    expect(tierForCitation({ pubtype: ["Some Future Pubtype"] })).toBe(2);
  });

  it("returns Tier-1 if ANY pubtype matches Tier-1 (multi-pubtype precedence)", () => {
    expect(tierForCitation({ pubtype: ["Journal Article", "Randomized Controlled Trial"] })).toBe(1);
  });

  it("Tier-1 wins over Tier-3 when both present", () => {
    // Unlikely in real PubMed data but keep the rule strict.
    expect(tierForCitation({ pubtype: ["Editorial", "Meta-Analysis"] })).toBe(1);
  });
});

describe("tierLabel", () => {
  it("returns a human-readable label per tier", () => {
    expect(tierLabel(1)).toMatch(/Tier-1.*RCT/);
    expect(tierLabel(2)).toMatch(/Tier-2/);
    expect(tierLabel(3)).toMatch(/Tier-3.*anecdotal/);
  });
});

describe("constants", () => {
  it("Tier-1 and Tier-3 sets are disjoint", () => {
    for (const t1 of TIER1_PUBTYPES) {
      expect(TIER3_PUBTYPES.has(t1)).toBe(false);
    }
  });
});
