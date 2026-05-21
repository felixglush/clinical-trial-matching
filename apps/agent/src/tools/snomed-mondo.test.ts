import { describe, expect, it } from "vitest";

import { resolveSnomedCondition } from "./snomed-mondo.js";

// These SNOMED codes are the canonical Synthea-emitted codes for our four
// archetype-patient conditions. If any of these stop resolving after a
// crosswalk regen, the workflow is broken for the archetype set — fail fast.
describe("resolveSnomedCondition", () => {
  it("resolves rheumatoid arthritis", () => {
    const r = resolveSnomedCondition("69896004");
    expect(r).not.toBeNull();
    expect(r!.mondoId).toBe("MONDO:0008383");
    expect(r!.primekgName).toBe("rheumatoid arthritis");
  });

  it("resolves type 2 diabetes mellitus", () => {
    const r = resolveSnomedCondition("44054006");
    expect(r).not.toBeNull();
    expect(r!.mondoId).toBe("MONDO:0005148");
  });

  it("resolves non-small cell lung carcinoma", () => {
    const r = resolveSnomedCondition("254637007");
    expect(r).not.toBeNull();
    expect(r!.primekgName).toContain("non-small cell lung carcinoma");
  });

  it("resolves breast cancer", () => {
    const r = resolveSnomedCondition("254837009");
    expect(r).not.toBeNull();
    expect(r!.mondoId).toBe("MONDO:0007254");
  });

  it("resolves chronic kidney disease", () => {
    const r = resolveSnomedCondition("709044004");
    expect(r).not.toBeNull();
    expect(r!.mondoId).toBe("MONDO:0005300");
  });

  it("returns null for unknown SNOMED codes", () => {
    expect(resolveSnomedCondition("0000000000000")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(resolveSnomedCondition("")).toBeNull();
  });
});
