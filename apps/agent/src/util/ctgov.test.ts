import { describe, expect, it } from "vitest";

import {
  ENROLLING_STATUSES,
  isEnrollingStatus,
  parseAgeYears,
} from "./ctgov.js";

describe("parseAgeYears", () => {
  it("parses N Years", () => {
    expect(parseAgeYears("18 Years")).toBe(18);
    expect(parseAgeYears("75 Years")).toBe(75);
  });

  it("parses N Months as a fractional year", () => {
    expect(parseAgeYears("6 Months")).toBeCloseTo(0.5, 5);
    expect(parseAgeYears("24 Months")).toBeCloseTo(2, 5);
  });

  it("returns undefined for N/A", () => {
    expect(parseAgeYears("N/A")).toBeUndefined();
  });

  it("returns undefined for missing or unparseable strings", () => {
    expect(parseAgeYears(undefined)).toBeUndefined();
    expect(parseAgeYears("")).toBeUndefined();
    expect(parseAgeYears("18")).toBeUndefined();
    expect(parseAgeYears("eighteen years")).toBeUndefined();
  });
});

describe("isEnrollingStatus", () => {
  it("returns true for enrolling-ish statuses", () => {
    for (const s of ENROLLING_STATUSES) {
      expect(isEnrollingStatus(s)).toBe(true);
    }
  });

  it("returns false for non-enrolling statuses", () => {
    expect(isEnrollingStatus("COMPLETED")).toBe(false);
    expect(isEnrollingStatus("WITHDRAWN")).toBe(false);
    expect(isEnrollingStatus("TERMINATED")).toBe(false);
    expect(isEnrollingStatus("SUSPENDED")).toBe(false);
  });

  it("returns false for empty / unknown strings", () => {
    expect(isEnrollingStatus("")).toBe(false);
    expect(isEnrollingStatus("not a real status")).toBe(false);
  });
});
